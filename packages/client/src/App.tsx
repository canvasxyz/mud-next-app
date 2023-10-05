import { useState, useRef } from "react"
import { useLiveQuery } from "@canvas-js/modeldb"
import { useMUD } from "./MUDContext"
import { useCanvas } from "./canvas-mudevm"
import { getNetworkConfig } from "./mud/getNetworkConfig"
import mudConfig from "contracts/mud.config"

import OnchainModules from "./OnchainModules"

export const App = () => {
  const [errorMsg, setErrorMsg] = useState<string>()
  const inputRef = useRef<any>()
  const mud = useMUD()

  const app = useCanvas({
    world: {
      mudConfig,
      worldContract: mud.network.worldContract,
      getPrivateKey: () => getNetworkConfig().then((n) => n.privateKey),
    },
    offline: true,
  })

  const sendMsg = () => {
    setErrorMsg("")
    const text = inputRef.current.value
    if (!text || app === undefined) return

    app.actions
      .sendOffchainMessage({ message: text })
      .then(() => (inputRef.current.value = ""))
      .catch((err: Error) => {
        setErrorMsg(err.toString())
        console.error(err)
      })
  }

  const messages = useLiveQuery(app?.db, "OffchainMessagesTable", {
    limit: 50,
    orderBy: { _key: "asc" },
  })

  return (
    <>
      <OnchainModules />
      <div>
        <div
          style={{
            border: "1px solid #eee",
            padding: "20px 30px",
            margin: "20px 0",
          }}
        >
          {(messages || []).map((msg, idx) => (
            <div key={idx}>
              [{msg.timestamp?.toString()}] {msg.from}: {msg.message}
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            sendMsg()
          }}
        >
          <input
            type="text"
            ref={inputRef}
            placeholder="Type a message"
            autoFocus
          />
          <button type="submit">Send</button>
          {errorMsg && (
            <div style={{ marginTop: "10px", color: "#dd0022" }}>
              {errorMsg}
            </div>
          )}
        </form>
      </div>
    </>
  )
}
