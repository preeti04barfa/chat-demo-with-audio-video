
import { useEffect, useState } from "react"
import { Phone, PhoneOff, Video } from "lucide-react"
export function CallNotification({ call, onAccept, onReject }) {
  const [isRinging, setIsRinging] = useState(true)

  useEffect(() => {
    const interval = setInterval(() => {
      setIsRinging((prev) => !prev)
    }, 1000)

    return () => {
      clearInterval(interval)
    }
  }, [])

  const getDisplayName = () => {
    if (call.isGroupCall) {
      return call.groupName || "Group Call"
    } else {
      return call.caller?.name || "Unknown"
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
      <div
        className={`bg-white rounded-lg p-8 max-w-md w-full mx-4 text-center transition-all duration-300 ${
          isRinging ? "scale-105" : "scale-100"
        }`}
      >
        <div className="mb-6">
          <div className="w-20 h-20 bg-blue-500 text-white rounded-full flex items-center justify-center text-2xl font-bold mx-auto mb-4">
            {getDisplayName().charAt(0).toUpperCase()}
          </div>
          <h2 className="text-xl font-semibold mb-2">{getDisplayName()}</h2>
          <p className="text-gray-600 mb-2">
            {call.isGroupCall ? "Group" : "Incoming"} {call.callType} call
          </p>
          <div className="flex items-center justify-center gap-2 text-blue-600">
            {call.callType === "video" ? <Video className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
            <span className="animate-pulse">Ringing...</span>
          </div>
        </div>

        <div className="flex gap-4 justify-center">
          <button
            onClick={onReject}
            className="w-16 h-16 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
          <button
            onClick={onAccept}
            className="w-16 h-16 bg-green-500 text-white rounded-full flex items-center justify-center hover:bg-green-600 transition-colors"
          >
            <Phone className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  )
}
