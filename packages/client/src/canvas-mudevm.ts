import { Canvas, ActionImplementation, JSValue } from "@canvas-js/core"
import { SIWESigner } from "@canvas-js/chain-ethereum"
import { PrimitiveType, PropertyType } from "@canvas-js/modeldb"
import { typeOf } from "@canvas-js/vm"

import { useEffect, useState } from "react"
import type {
  Abi,
  AbiItem,
  Hex,
  SimulateContractParameters,
  WalletClient,
  LocalAccount,
  ContractFunctionResult,
} from "viem"
import type { AbiFunction, AbiParameter, AbiType, SolidityTuple } from "abitype"
import { ethers } from "ethers"

import mudConfig from "contracts/mud.config"
import IWorldAbi from "contracts/out/IWorld.sol/IWorld.abi.json"
import { SetupResult } from "./mud/setup"
import { getNetworkConfig } from "./mud/getNetworkConfig"

// to use https://abitype.dev/api/zod
const abiTypeToModelType = (abitype: AbiType) => {
  return "string" as PropertyType
}
const encode = (data: string | bigint, abitype: AbiType) => {
  if (typeof data === "bigint") {
    return data.toString()
  } else {
    return data
  }
}

export const useCanvas = (props: {
  world: { mud: SetupResult; getNetworkConfig: typeof getNetworkConfig }
  offline: boolean
}) => {
  const [app, setApp] = useState<Canvas>()
  // should we reset the app when config changes?

  useEffect(() => {
    const buildContract = async () => {
      const { offline, world } = props

      const models = Object.entries(mudConfig.tables).filter(
        ([tableName, params]) =>
          params.offchainOnly === true /* && params.offchainSync === true */
      )
      if (models.length === 0) {
        throw new Error("No offchain-synced tables defined")
      }

      const systems = Object.entries(mudConfig.systems).filter(
        ([systemName, params]) => true /* params.offchainSync === true */
      )
      if (models.length === 0) {
        throw new Error("No offchain-synced systems defined")
      }

      const globs = import.meta.glob(
        "./../../contracts/out/*System.sol/*.abi.json",
        { as: "raw" }
      )

      // build models
      const modelsSpec = Object.fromEntries(
        models.map(([name, params]) => [
          name,
          {
            // ...Object.fromEntries(
            //   Object.entries(params.keySchema).map(([field, type]) => [
            //     field,
            //     "string",
            //   ])
            // ),
            ...Object.fromEntries(
              Object.entries(params.valueSchema).map(([field, type]) => [
                field,
                abiTypeToModelType(type),
              ])
            ),
            // TODO: $indexes
            // TODO: { mutable: true }
          },
        ])
      )

      // build actions
      const actionsSpec = {}
      for (const [name] of systems) {
        // this should be parallelized
        const systemAbiRaw = await globs[
          `../../contracts/out/${name}.sol/${name}.abi.json`
        ]()
        const systemAbi = JSON.parse(systemAbiRaw)

        // this is hacky, what other functions might be on systems? (look at system codegen)
        const calls = systemAbi.filter(
          (entry: AbiItem) =>
            entry.type === "function" &&
            !entry.name.startsWith("_") &&
            entry.stateMutability !== "pure"
        )

        const actions = Object.fromEntries(
          calls.map((abiParams: AbiFunction) => {
            const actionHandler: ActionImplementation = async (
              db,
              args = {},
              context
            ) => {
              // args: Record<string, JSValue> or JSValue?
              return new Promise((resolve, reject) => {
                const tableName = abiParams.outputs[0].internalType
                  ?.replace(/^struct /, "")
                  .replace(/Data$/, "")
                if (tableName === undefined) return reject()
                if (typeOf(args) !== "Object" || args === null) return reject()

                const { publicClient, worldContract } = props.world.mud.network
                publicClient
                  .simulateContract({
                    account: context.address as Hex,
                    address: worldContract.address as Hex,
                    abi: IWorldAbi,
                    functionName: abiParams.name as any,
                    // @ts-ignore
                    args: abiParams.inputs.map((item) => args[item.name]),
                    gasPrice: 0n,
                  })
                  .then(({ result }) => {
                    // The user-provided `timestamp` from canvas/p2psync doesn't
                    // have any guarantees now. We should actions have monotonically
                    // increasing timestamps, to make it safe for multi-user LWW.

                    // Encode result which is an EVM ABI return type for modeldb.
                    if (typeof result !== "object") return reject()

                    const encodedResult = Object.fromEntries(
                      Object.entries(result).map(([name, value]) => {
                        // @ts-ignore
                        const abitype = abiParams.outputs[0].components.find(
                          (item: AbiFunction) => item.name === name
                        ).type
                        return [name, encode(value, abitype as AbiType)]
                      })
                    )

                    db[tableName].set(tableName, encodedResult)
                    resolve(encodedResult)
                  })
                  .catch((err: Error) => {
                    reject(err)
                  })
              })
            }

            return [abiParams.name, actionHandler]
          })
        )
        Object.assign(actionsSpec, actions)
      }

      // viem to ethers requires us to get the private key
      // in the future we should just make a SIWESigner that accepts viem accounts
      const { privateKey } = await getNetworkConfig()
      const wallet = new ethers.Wallet(privateKey)

      // create application
      const topic = "hello.world"
      const app = await Canvas.initialize({
        contract: {
          topic,
          models: modelsSpec,
          actions: actionsSpec,
        },
        offline,
        signers: [new SIWESigner({ signer: wallet as any })],
        // TODO: client needs to be upgraded from ethers@5.7.2 to ethers@6.6.6 to match @canvas-js/core
        location: "sqldb",
      })
      setApp(app)
    }

    buildContract()
  }, [
    props.offline,
    props.world.mud.network.worldContract.address,
    props.world.getNetworkConfig,
  ])

  return app
}
