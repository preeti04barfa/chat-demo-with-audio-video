import { useState } from "react"
import { MessageList } from "./message-list"
import { ChatInput } from "./chat-input"
import { Video, Phone } from "lucide-react"


export function GroupChat({
  group,
  messages,
  currentUser,
  sendMessage,
  message,
  setMessage,
  isAdmin,
  onVideoCall,
  onAudioCall,
}) {
  const [showSettings, setShowSettings] = useState(false)

  if (!group) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Select a group to start chatting</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Group Header */}
      <div className="bg-white p-4 border-b flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{group.name}</h2>
            <div className="text-sm text-gray-500">{group.members ? group.members.length : 0} members</div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onAudioCall}
              className="p-2 rounded-full hover:bg-gray-100 transition-colors"
              title="Group Audio Call"
            >
              <Phone className="w-5 h-5 text-blue-600" />
            </button>
            <button
              onClick={onVideoCall}
              className="p-2 rounded-full hover:bg-gray-100 transition-colors"
              title="Group Video Call"
            >
              <Video className="w-5 h-5 text-blue-600" />
            </button>
            {isAdmin && (
              <button className="p-2 hover:bg-gray-100 rounded" onClick={() => setShowSettings(!showSettings)}>
                ⚙️
              </button>
            )}
          </div>
        </div>

        {showSettings && isAdmin && (
          <div className="mt-4 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-semibold mb-2">Group Settings</h3>
            <div>
              <h4 className="text-sm font-medium mb-2">Members</h4>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {group.members &&
                  group.members.map((member) => (
                    <div key={member._id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-xs">
                          {member.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm">{member.name}</span>
                      </div>
                      <button className="text-red-500 text-sm hover:underline">Remove</button>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0">
        <MessageList
          messages={messages || []}
          currentUser={currentUser}
          callHistory={[]} // Group call history will be handled separately
          onCall={() => {}} // No individual calls from group chat
        />
      </div>

      {/* Input */}
      <div className="bg-white p-4 border-t flex-shrink-0">
        <ChatInput message={message} setMessage={setMessage} sendMessage={sendMessage} disabled={!group} />
      </div>
    </div>
  )
}
