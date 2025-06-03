import { Video, Phone, UserPlus } from "lucide-react"

export function GroupList({
  groups,
  currentGroup,
  onGroupSelect,
  onOpenGroupModal,
  users,
  isCreatingGroup,
  onGroupVideoCall,
  onGroupAudioCall,
  onJoinGroupCall,
  activeGroupCalls = {},
}) {
  return (
    <div className="p-4 border-b flex-shrink-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Groups ({groups ? groups.length : 0})</h3>
        <button
          className="w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center hover:bg-blue-600 flex-shrink-0"
          onClick={onOpenGroupModal}
          aria-label="Add Group"
        >
          +
        </button>
      </div>

      <div className="space-y-2 max-h-48 overflow-y-auto">
        {isCreatingGroup && (
          <div className="text-center text-gray-500 py-2">
            <p>Creating group...</p>
          </div>
        )}

        {groups && groups.length > 0 ? (
          groups.map((group) => {
            const activeCall = activeGroupCalls[group._id]
            const isCallActive = activeCall && activeCall.status === "active"

            return (
              <div
                key={group._id}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                  currentGroup?._id === group._id ? "bg-green-100 border border-green-300" : "hover:bg-gray-100"
                } ${isCallActive ? "bg-green-50 border border-green-200" : ""}`}
                onClick={() => onGroupSelect(group)}
              >
                <div className="relative">
                  <div className="w-10 h-10 bg-green-500 text-white rounded-full flex items-center justify-center font-semibold flex-shrink-0">
                    {group.name.charAt(0).toUpperCase()}
                  </div>
                  {isCallActive && (
                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                      <Phone className="w-2 h-2 text-white" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{group.name}</div>
                  <div className="text-sm text-gray-500">
                    {group.members ? group.members.length : 0} members
                    {isCallActive && <span className="text-green-600 font-medium ml-2">• SFU Call Active</span>}
                  </div>
                </div>
                {currentGroup?._id === group._id && (
                  <div className="flex gap-1">
                    {isCallActive ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onJoinGroupCall(group._id, activeCall.callType) // Pass the actual call type
                        }}
                        className="p-1 rounded hover:bg-gray-200 bg-green-100"
                        title={`Join Active ${activeCall.callType === "video" ? "Video" : "Audio"} Call (SFU)`}
                      >
                        <UserPlus className="w-4 h-4 text-green-600" />
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onGroupAudioCall()
                          }}
                          className="p-1 rounded hover:bg-gray-200"
                          title="Group Audio Call (SFU)"
                        >
                          <Phone className="w-4 h-4 text-blue-600" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onGroupVideoCall()
                          }}
                          className="p-1 rounded hover:bg-gray-200"
                          title="Group Video Call (SFU)"
                        >
                          <Video className="w-4 h-4 text-blue-600" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })
        ) : (
          <div className="text-center text-gray-500 py-4">
            <p className="text-sm mb-2">No groups yet</p>
            <button className="text-blue-500 text-sm hover:underline" onClick={onOpenGroupModal}>
              Create your first group
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
