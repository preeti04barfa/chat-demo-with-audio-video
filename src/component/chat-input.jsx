export function ChatInput({ message, setMessage, sendMessage, disabled }) {
  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !disabled) {
      sendMessage()
    }
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        placeholder={disabled ? "Select a user to chat" : "Type a message..."}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyPress={handleKeyPress}
        disabled={disabled}
        className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
      />
      <button
        onClick={sendMessage}
        disabled={disabled || !message.trim()}
        className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
      >
        Send
      </button>
    </div>
  )
}
