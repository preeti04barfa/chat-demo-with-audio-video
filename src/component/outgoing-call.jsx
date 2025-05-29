import { useEffect, useState } from "react"
import { Phone, PhoneOff, Video, VideoOff } from "lucide-react"

export function OutgoingCall({ call, onEndCall }) {
  console.log(call, "call");
  
  const [callDuration, setCallDuration] = useState(0)
  const [isRinging, setIsRinging] = useState(true)
  const [callStatus, setCallStatus] = useState("ringing") // "ringing", "connected", "engaged"

  useEffect(() => {
    const ringInterval = setInterval(() => {
      setIsRinging((prev) => !prev)
    }, 1000)


    let durationTimer
    if (call.status === "connected") {
      setCallStatus("connected")
      durationTimer = setInterval(() => {
        setCallDuration((prev) => prev + 1)
      }, 1000)
    }

    return () => {
      clearInterval(ringInterval)
      if (durationTimer) clearInterval(durationTimer)
    }
  }, [call.status])

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const getDisplayName = () => {
    if (call.isGroupCall) {
      return call.groupName || "Group Call"
    } else {
      return call.receiver?.name || "User"
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
      <div
        className={`bg-white rounded-lg p-8 max-w-md w-full mx-4 text-center transition-all duration-300 ${
          isRinging && callStatus === "ringing" ? "scale-105" : "scale-100"
        }`}
      >
        <div className="mb-6">
          <div className="w-20 h-20 bg-blue-500 text-white rounded-full flex items-center justify-center text-2xl font-bold mx-auto mb-4">
            {getDisplayName().charAt(0).toUpperCase()}
          </div>
          <h2 className="text-xl font-semibold mb-2">{getDisplayName()}</h2>
          <p className="text-gray-600 mb-2">
            {callStatus === "connected" ? "Connected" : callStatus === "engaged" ? "Call Engaged" : "Calling..."} (
            {call.callType} call)
          </p>
          {callStatus === "ringing" ? (
            <div className="flex items-center justify-center gap-2 text-blue-600">
              {call.callType === "video" ? <Video className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
              <span className="animate-pulse">Ringing...</span>
            </div>
          ) : callStatus === "engaged" ? (
            <div className="text-red-600 font-medium">User is on another call</div>
          ) : (
            <div className="text-green-600 font-medium">{formatDuration(callDuration)}</div>
          )}
        </div>

        <div className="flex justify-center">
          <button
            onClick={onEndCall}
            className="w-16 h-16 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors"
          >
            {call.callType === "video" ? <VideoOff className="w-6 h-6" /> : <PhoneOff className="w-6 h-6" />}
          </button>
        </div>
      </div>
    </div>
  )
}
