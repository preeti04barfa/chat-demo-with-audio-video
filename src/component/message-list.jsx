
import { useEffect, useRef } from "react"
import { CallHistoryMessage } from "./call-history-message"

export function MessageList({ messages, currentUser, callHistory, onCall }) {
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, callHistory])

  const combinedItems = []

  if (messages) {
    messages.forEach((msg) => {
      combinedItems.push({
        type: "message",
        data: msg,
        timestamp: new Date(msg.timestamp || msg.createdAt),
      })
    })
  }

  if (callHistory) {
    callHistory.forEach((call) => {
      combinedItems.push({
        type: "call",
        data: call,
        timestamp: new Date(call.startTime),
      })
    })
  }

  // Sort by timestamp
  combinedItems.sort((a, b) => a.timestamp - b.timestamp)

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {combinedItems && combinedItems.length > 0 ? (
        <>
          {combinedItems.map((item, index) => (
            <div key={`${item.type}-${index}`}>
              {item.type === "message" ? (
                <div className={`flex ${item.data.sender?._id === currentUser.id ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                      item.data.sender?._id === currentUser.id ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-800"
                    }`}
                  >
                    {item.data.sender?._id !== currentUser.id && (
                      <div className="text-xs font-semibold mb-1">{item.data.sender?.name || "Unknown"}</div>
                    )}

                    <div className="break-words">
                      {item.data.type === "image" ? (
                        <img
                          src={item.data.message || "/placeholder.svg"}
                          alt="chat media"
                          className="max-w-full h-auto rounded"
                          loading="lazy"
                        />
                      ) : (
                        <span>{item.data.message}</span>
                      )}
                    </div>

                    <div className="text-xs opacity-75 mt-1">
                      {new Date(item.data.timestamp || item.data.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <CallHistoryMessage call={item.data} currentUser={currentUser} onCall={onCall} />
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </>
      ) : (
        <div className="h-full flex items-center justify-center">
          <p className="text-gray-500">No messages yet. Start the conversation!</p>
        </div>
      )}
    </div>
  )
}
