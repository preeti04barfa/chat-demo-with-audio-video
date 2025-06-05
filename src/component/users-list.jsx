
export function UsersList({ users, currentChatUser, onUserSelect }) {
  const formatLastSeen = (lastSeen) => {
    if (!lastSeen) return ""
    const now = new Date()
    const lastSeenDate = new Date(lastSeen)
    const diffInMinutes = Math.floor((now - lastSeenDate) / (1000 * 60))

    if (diffInMinutes < 1) return "Just now"
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`

    const diffInHours = Math.floor(diffInMinutes / 60)
    if (diffInHours < 24) return `${diffInHours}h ago`

    const diffInDays = Math.floor(diffInHours / 24)
    if (diffInDays < 7) return `${diffInDays}d ago`

    return lastSeenDate.toLocaleDateString()
  }

  return (
    <div className="flex-1 p-4 overflow-y-auto min-h-0">
      <h3 className="font-semibold mb-3">All Users ({users ? users.length : 0})</h3>
      <div className="space-y-2">
        {users && users.length > 0 ? (
          users.map((user) => (
            <div
              key={user._id}
              className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                currentChatUser?._id === user._id ? "bg-blue-100 border border-blue-300" : "hover:bg-gray-100"
              }`}
              onClick={() => onUserSelect(user)}
            >
              <div className="relative">
                <div className="w-10 h-10 bg-blue-500 text-white rounded-full flex items-center justify-center font-semibold flex-shrink-0">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                {/* Online/Offline Status Dot */}
                <div
                  className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${
                    user.isOnline ? "bg-green-500" : "bg-red-500"
                  }`}
                  title={user.isOnline ? "Online" : "Offline"}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{user.name}</div>
                <div className="text-sm text-gray-500 truncate">
                  {user.isOnline ? (
                    <span className="text-green-600 font-medium">Online</span>
                  ) : (
                    <span className="text-gray-500">Last seen {formatLastSeen(user.lastSeen)}</span>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="text-center text-gray-500 py-4">
            <p>No users found</p>
          </div>
        )}
      </div>
    </div>
  )
}
