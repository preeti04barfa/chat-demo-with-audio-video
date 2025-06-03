import { ArrowLeft, Phone, Video, PhoneIncoming, PhoneOutgoing, PhoneMissed } from "lucide-react"

export function CallHistory({ callHistory, currentUser, onBack, onCall }) {
  const formatDuration = (seconds) => {
    if (!seconds || seconds === 0) return "0:00"
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  const formatTime = (dateString) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffTime = Math.abs(now - date)
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

    if (diffDays === 1) {
      return "Today " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    } else if (diffDays === 2) {
      return "Yesterday " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    } else if (diffDays <= 7) {
      return (
        date.toLocaleDateString([], { weekday: "short" }) +
        " " +
        date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      )
    } else {
      return (
        date.toLocaleDateString([], { month: "short", day: "numeric" }) +
        " " +
        date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      )
    }
  }

  const getCallIcon = (call) => {
    const isIncoming = call.receiver && call.receiver._id === currentUser.id
    const isOutgoing = call.caller._id === currentUser.id

    if (call.status === "missed") {
      return <PhoneMissed className="w-4 h-4 text-red-500" />
    } else if (isIncoming) {
      return <PhoneIncoming className="w-4 h-4 text-green-500" />
    } else if (isOutgoing) {
      return <PhoneOutgoing className="w-4 h-4 text-blue-500" />
    }
    return <Phone className="w-4 h-4 text-gray-500" />
  }

  const getCallName = (call) => {
    if (call.isGroupCall) {
      return call.groupId?.name || "Group Call"
    } else {
      const isIncoming = call.receiver && call.receiver._id === currentUser.id
      return isIncoming ? call.caller.name : call.receiver?.name || "Unknown"
    }
  }

  const getCallUser = (call) => {
    if (call.isGroupCall) return null
    const isIncoming = call.receiver && call.receiver._id === currentUser.id
    return isIncoming ? call.caller : call.receiver
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <div className="bg-white shadow-sm p-4 border-b flex-shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 rounded-full hover:bg-gray-100 transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-semibold">Call History</h1>
        </div>
      </div>

      {/* Call History List */}
      <div className="flex-1 overflow-y-auto bg-white">
        {callHistory && callHistory.length > 0 ? (
          <div className="divide-y divide-gray-200">
            {callHistory.map((call) => {
              const callUser = getCallUser(call)
              return (
                <div key={call._id} className="p-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3">
                    {/* Avatar */}
                    <div className="w-12 h-12 bg-blue-500 text-white rounded-full flex items-center justify-center font-semibold flex-shrink-0">
                      {getCallName(call).charAt(0).toUpperCase()}
                    </div>

                    {/* Call Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium truncate">{getCallName(call)}</h3>
                        {getCallIcon(call)}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-gray-500">
                        <span>{formatTime(call.startTime)}</span>
                        {call.duration > 0 && (
                          <>
                            <span>•</span>
                            <span>{formatDuration(call.duration)}</span>
                          </>
                        )}
                        <span>•</span>
                        <span className="capitalize">{call.status}</span>
                      </div>
                    </div>

                    {/* Call Actions */}
                    {!call.isGroupCall && callUser && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => onCall(callUser, "audio")}
                          className="p-2 rounded-full hover:bg-gray-200 transition-colors"
                          title="Audio Call"
                        >
                          <Phone className="w-4 h-4 text-green-600" />
                        </button>
                        <button
                          onClick={() => onCall(callUser, "video")}
                          className="p-2 rounded-full hover:bg-gray-200 transition-colors"
                          title="Video Call"
                        >
                          <Video className="w-4 h-4 text-blue-600" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-500">
              <Phone className="w-16 h-16 mx-auto mb-4 text-gray-300" />
              <p className="text-lg font-medium">No call history</p>
              <p className="text-sm">Your calls will appear here</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
