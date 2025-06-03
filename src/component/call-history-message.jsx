import { Phone, Video, PhoneIncoming, PhoneOutgoing, PhoneMissed, Clock } from 'lucide-react'

export function CallHistoryMessage({ call, currentUser, onCall }) {
  const isIncoming = call.receiver && call.receiver._id === currentUser.id
  const isOutgoing = call.caller._id === currentUser.id

  const formatDuration = (seconds) => {
    if (!seconds || seconds === 0) return "0:00"
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  const getCallIcon = () => {
    if (call.status === "missed") {
      return <PhoneMissed className="w-4 h-4 text-red-500" />
    } else if (isIncoming) {
      return <PhoneIncoming className="w-4 h-4 text-green-500" />
    } else if (isOutgoing) {
      return <PhoneOutgoing className="w-4 h-4 text-blue-500" />
    }
    return <Phone className="w-4 h-4 text-gray-500" />
  }

  const getCallStatus = () => {
    switch (call.status) {
      case "missed":
        return "Missed call"
      case "rejected":
        return "Call declined"
      case "completed":
        return `Call ended • ${formatDuration(call.duration)}`
      case "accepted":
        return call.duration > 0 ? `Call ended • ${formatDuration(call.duration)}` : "Call ended"
      default:
        return "Call"
    }
  }

  const getCallUser = () => {
    if (call.isGroupCall) return null
    return isIncoming ? call.caller : call.receiver
  }

  const callUser = getCallUser()

  return (
    <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border">
      <div className="flex items-center gap-2">
        {call.callType === "video" ? (
          <Video className="w-5 h-5 text-blue-600" />
        ) : (
          <Phone className="w-5 h-5 text-green-600" />
        )}
        {getCallIcon()}
      </div>

      <div className="flex-1">
        <div className="font-medium text-sm">
          {call.isGroupCall ? `Group ${call.callType} call` : `${call.callType.charAt(0).toUpperCase() + call.callType.slice(1)} call`}
        </div>
        <div className="text-xs text-gray-500 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {getCallStatus()}
        </div>
        <div className="text-xs text-gray-400">
          {new Date(call.startTime).toLocaleString()}
        </div>
      </div>

      {!call.isGroupCall && callUser && call.status !== "ringing" && (
        <div className="flex gap-1">
          <button
            onClick={() => onCall(callUser, "audio")}
            className="p-1 rounded hover:bg-gray-200 transition-colors"
            title="Call back"
          >
            <Phone className="w-4 h-4 text-green-600" />
          </button>
          <button
            onClick={() => onCall(callUser, "video")}
            className="p-1 rounded hover:bg-gray-200 transition-colors"
            title="Video call back"
          >
            <Video className="w-4 h-4 text-blue-600" />
          </button>
        </div>
      )}
    </div>
  )
}