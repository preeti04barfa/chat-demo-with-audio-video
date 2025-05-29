import { useState, useEffect, useCallback } from "react"
import { UsersList } from "./users-list"
import { MessageList } from "./message-list"
import { ChatInput } from "./chat-input"
import { GroupList } from "./group-list"
import { GroupModal } from "./group-modal"
import { GroupChat } from "./group-chat"
import { CallNotification } from "./call-notification"
import { CallInterface } from "./call-interface"
import { OutgoingCall } from "./outgoing-call"
import { Video, Phone, History } from "lucide-react"
import { CallHistory } from "./call-history"

export default function ChatApp({ socket, user }) {
  const [message, setMessage] = useState("")
  const [chatHistories, setChatHistories] = useState({})
  const [currentRoomId, setCurrentRoomId] = useState("")
  const [currentChatUser, setCurrentChatUser] = useState(null)
  const [users, setUsers] = useState([])

  const [groups, setGroups] = useState([])
  const [currentGroup, setCurrentGroup] = useState(null)
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false)
  const [isGroupChat, setIsGroupChat] = useState(false)
  const [isCreatingGroup, setIsCreatingGroup] = useState(false)

  const [incomingCall, setIncomingCall] = useState(null)
  const [outgoingCall, setOutgoingCall] = useState(null)
  const [currentCall, setCurrentCall] = useState(null)
  const [isInCall, setIsInCall] = useState(false)
  const [callHistory, setCallHistory] = useState([])
  const [showCallHistory, setShowCallHistory] = useState(false)
  const [callEngagedMessage, setCallEngagedMessage] = useState(null)

  // Audio elements for ring tones
  const [ringAudio, setRingAudio] = useState(null)

  useEffect(() => {
    // Initialize ring audio with better error handling
    const initializeAudio = async () => {
      try {
        // Initialize audio context first to ensure audio works
        const audioContext = new (window.AudioContext || window.webkitAudioContext)()

        const audio = new Audio()

        // Try to load the ring audio file with correct path
        audio.src = "/ring.mp3"
        audio.loop = true
        audio.volume = 0.7
        audio.preload = "auto"

        // Test audio output capability
        const testOscillator = audioContext.createOscillator()
        const gainNode = audioContext.createGain()
        testOscillator.connect(gainNode)
        gainNode.connect(audioContext.destination)
        gainNode.gain.value = 0.01 // Very quiet test tone
        testOscillator.frequency.value = 440
        testOscillator.type = "sine"
        testOscillator.start()
        setTimeout(() => testOscillator.stop(), 100)

        // Handle audio loading
        audio.addEventListener("canplaythrough", () => {
          console.log("Ring audio loaded successfully")
          setRingAudio(audio)
        })

        audio.addEventListener("error", (e) => {
          console.error("Error loading ring audio:", e)
          // Create a fallback beep sound using Web Audio API
          createFallbackRingTone()
        })

        // Try to load the audio
        await audio.load()
      } catch (error) {
        console.error("Failed to initialize ring audio:", error)
        createFallbackRingTone()
      }
    }

    const createFallbackRingTone = () => {
      // Create a more robust beep using Web Audio API as fallback
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()

      let interval

      const createBeep = () => {
        const oscillator = audioContext.createOscillator()
        const gainNode = audioContext.createGain()

        oscillator.connect(gainNode)
        gainNode.connect(audioContext.destination)

        oscillator.frequency.value = 800
        oscillator.type = "sine"

        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime)
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5)

        oscillator.start(audioContext.currentTime)
        oscillator.stop(audioContext.currentTime + 0.5)
      }

      const fallbackAudio = {
        play: () => {
          createBeep()
          // Create repeating beep pattern
          interval = setInterval(createBeep, 1000)
          return Promise.resolve()
        },
        pause: () => {
          if (interval) {
            clearInterval(interval)
            interval = null
          }
        },
        currentTime: 0,
      }

      setRingAudio(fallbackAudio)
    }

    initializeAudio()

    return () => {
      if (ringAudio && ringAudio.pause) {
        ringAudio.pause()
        if (ringAudio.currentTime !== undefined) {
          ringAudio.currentTime = 0
        }
      }
    }
  }, [])

  const requestUserList = useCallback(() => {
    if (socket && socket.connected) {
      socket.emit("BE-get-users")
    }
  }, [socket])

  const requestGroupList = useCallback(() => {
    if (socket && socket.connected) {
      socket.emit("BE-get-groups")
    }
  }, [socket])

  const requestCallHistory = useCallback(() => {
    if (socket && socket.connected) {
      socket.emit("BE-get-call-history")
    }
  }, [socket])

  useEffect(() => {
    if (!socket) return

    // User list events
    socket.on("FE-user-list", (userList) => {
      console.log("Received user list:", userList)
      setUsers(userList || [])
    })

    // Group events
    socket.on("FE-group-list", (groupList) => {
      console.log("Received group list:", groupList)
      setGroups(groupList || [])
      setIsCreatingGroup(false)
    })

    socket.on("FE-group-created", ({ group }) => {
      console.log("Group created:", group)
      setIsCreatingGroup(false)
      requestGroupList()
    })

    // Private chat events
    socket.on("FE-private-room-joined", ({ roomId, withUser }) => {
      console.log("Joined private room:", { roomId, withUser })
      setCurrentRoomId(roomId)
      setCurrentChatUser(withUser)
      setCurrentGroup(null)
      setIsGroupChat(false)

      // Join the socket room
      socket.emit("BE-join-room", { roomId })

      socket.emit("BE-get-chat-history", { roomId })
    })

    socket.on("FE-private-message", (messageData) => {
      console.log("Received private message:", messageData)
      setChatHistories((prev) => {
        const roomMessages = prev[messageData.roomId] || []
        return {
          ...prev,
          [messageData.roomId]: [...roomMessages, messageData],
        }
      })
    })

    // Group chat events
    socket.on("FE-group-joined", ({ groupId, group }) => {
      console.log("Joined group:", { groupId, group })
      setCurrentRoomId(groupId)
      setCurrentGroup(group)
      setCurrentChatUser(null)
      setIsGroupChat(true)

      // Join the socket room
      socket.emit("BE-join-room", { roomId: groupId })

      socket.emit("BE-get-group-history", { groupId })
    })

    socket.on("FE-group-message", (messageData) => {
      console.log("Received group message:", messageData)
      setChatHistories((prev) => {
        const roomMessages = prev[messageData.groupId] || []
        return {
          ...prev,
          [messageData.groupId]: [...roomMessages, messageData],
        }
      })
    })

    socket.on("FE-chat-history", ({ roomId, messages }) => {
      console.log("Received chat history for room:", roomId, messages)
      setChatHistories((prev) => ({
        ...prev,
        [roomId]: messages || [],
      }))
    })

    socket.on("FE-group-history", ({ groupId, messages }) => {
      console.log("Received group history for group:", groupId, messages)
      setChatHistories((prev) => ({
        ...prev,
        [groupId]: messages || [],
      }))
    })

    // Call events
    socket.on("FE-incoming-call", (callData) => {
      console.log("Incoming call:", callData)

      // If already in a call, don't show the incoming call notification
      if (isInCall || currentCall || incomingCall || outgoingCall) {
        console.log("Already in a call, ignoring incoming call")
        // Automatically reject the call
        socket.emit("BE-reject-call", {
          callId: callData.callId,
          reason: "busy",
        })
        return
      }

      // Play ring sound with better error handling
      if (ringAudio) {
        try {
          if (ringAudio.currentTime !== undefined) {
            ringAudio.currentTime = 0
          }
          const playPromise = ringAudio.play()
          if (playPromise !== undefined) {
            playPromise.catch((error) => {
              console.error("Error playing ring sound:", error)
            })
          }
        } catch (error) {
          console.error("Error playing ring sound:", error)
        }
      }

      setIncomingCall(callData)
    })

    socket.on("FE-call-accepted", ({ callId, acceptedBy, isGroupCall }) => {
      console.log("Call accepted:", { callId, acceptedBy, isGroupCall })

      // Stop ring sound
      if (ringAudio && ringAudio.pause) {
        ringAudio.pause()
        if (ringAudio.currentTime !== undefined) {
          ringAudio.currentTime = 0
        }
      }

      // Clear incoming call
      setIncomingCall(null)

      // Update outgoing call status to connected and move to call interface
      if (outgoingCall && outgoingCall.callId === callId) {
        const connectedCall = { ...outgoingCall, status: "connected" }
        setCurrentCall(connectedCall)
        setOutgoingCall(null)
        setIsInCall(true)
      }

      // Refresh call history
      requestCallHistory()
    })

    // NEW: Handle call engaged response
    socket.on("FE-call-engaged", ({ callId, userId, userName }) => {
      console.log("Call engaged:", { callId, userId, userName })

      // Stop ring sound
      if (ringAudio && ringAudio.pause) {
        ringAudio.pause()
        if (ringAudio.currentTime !== undefined) {
          ringAudio.currentTime = 0
        }
      }

      // Show call engaged message
      if (outgoingCall && outgoingCall.callId === callId) {
        setCallEngagedMessage({
          userName,
          timestamp: new Date(),
        })

        // Clear outgoing call
        setOutgoingCall(null)

        // Auto-dismiss after 3 seconds
        setTimeout(() => {
          setCallEngagedMessage(null)
        }, 3000)
      }

      // Refresh call history
      requestCallHistory()
    })

    socket.on("FE-call-rejected", ({ callId, rejectedBy, isGroupCall, reason }) => {
      console.log("Call rejected:", { callId, rejectedBy, isGroupCall, reason })

      // Stop ring sound
      if (ringAudio && ringAudio.pause) {
        ringAudio.pause()
        if (ringAudio.currentTime !== undefined) {
          ringAudio.currentTime = 0
        }
      }

      // Handle rejection for incoming call
      if (incomingCall?.callId === callId) {
        setIncomingCall(null)
      }

      // Handle rejection for outgoing call
      if (outgoingCall?.callId === callId) {
        if (reason === "busy") {
          // Show call engaged message
          setCallEngagedMessage({
            userName: rejectedBy.name,
            timestamp: new Date(),
          })

          // Auto-dismiss after 3 seconds
          setTimeout(() => {
            setCallEngagedMessage(null)
          }, 3000)
        } else {
          alert(`${rejectedBy.name} is currently on another call. Please try again later.`)
        }
        setOutgoingCall(null)
      }

      // Refresh call history
      requestCallHistory()
    })

    socket.on("FE-call-ended", ({ callId }) => {
      console.log("Call ended:", callId)

      // Stop ring sound
      if (ringAudio && ringAudio.pause) {
        ringAudio.pause()
        if (ringAudio.currentTime !== undefined) {
          ringAudio.currentTime = 0
        }
      }

      // Clear all call states
      setIncomingCall(null)
      setOutgoingCall(null)
      setCurrentCall(null)
      setIsInCall(false)

      // Refresh call history
      requestCallHistory()
    })

    socket.on("FE-call-history", (history) => {
      console.log("Received call history:", history)
      setCallHistory(history || [])
    })

    socket.on("FE-error", ({ message }) => {
      console.error("Socket error:", message)
      alert(message)
    })

    // Request initial data
    requestUserList()
    requestGroupList()
    requestCallHistory()

    return () => {
      socket.off("FE-user-list")
      socket.off("FE-group-list")
      socket.off("FE-group-created")
      socket.off("FE-private-room-joined")
      socket.off("FE-private-message")
      socket.off("FE-group-joined")
      socket.off("FE-group-message")
      socket.off("FE-chat-history")
      socket.off("FE-group-history")
      socket.off("FE-incoming-call")
      socket.off("FE-call-accepted")
      socket.off("FE-call-rejected")
      socket.off("FE-call-engaged")
      socket.off("FE-call-ended")
      socket.off("FE-call-history")
      socket.off("FE-error")
    }
  }, [
    socket,
    requestUserList,
    requestGroupList,
    requestCallHistory,
    incomingCall,
    currentCall,
    outgoingCall,
    ringAudio,
    isInCall,
  ])

  const sendMessage = () => {
    if (message.trim() && currentRoomId && socket && socket.connected) {
      console.log("Sending message:", { message: message.trim(), roomId: currentRoomId, isGroupChat })

      if (isGroupChat) {
        socket.emit("BE-send-group-message", {
          groupId: currentRoomId,
          message: message.trim(),
          type: "text",
        })
      } else {
        socket.emit("BE-send-private-message", {
          roomId: currentRoomId,
          message: message.trim(),
          type: "text",
        })
      }
      setMessage("")
    } else {
      console.log("Cannot send message:", {
        messageEmpty: !message.trim(),
        noRoomId: !currentRoomId,
        socketNotConnected: !socket?.connected,
      })
    }
  }

  const handleUserSelect = (targetUser) => {
    if (targetUser._id === user.id || !socket || !socket.connected) return

    console.log("Starting private chat with:", targetUser)
    socket.emit("BE-start-private-chat", {
      targetUserId: targetUser._id,
      message: `Started chat with ${targetUser.name}`,
    })
  }

  const handleCreateGroup = ({ name, members }) => {
    if (!name || !socket || !socket.connected) {
      console.error("Invalid group name or socket not connected:", name)
      return
    }

    console.log("Creating group:", { name, members })
    setIsCreatingGroup(true)

    socket.emit("BE-create-group", {
      name,
      members: members || [],
    })

    setIsGroupModalOpen(false)
  }

  const handleGroupSelect = (group) => {
    if (!socket || !socket.connected) return

    console.log("Joining group:", group)
    socket.emit("BE-join-group", { groupId: group._id })
  }

  const handleVideoCall = () => {
    if (currentChatUser && socket && socket.connected) {
      // Check if the user is already in a call
      if (isInCall || currentCall || incomingCall || outgoingCall) {
        alert("You are already in a call. Please end the current call before starting a new one.")
        return
      }

      const callData = {
        callId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        caller: user,
        receiver: currentChatUser,
        callType: "video",
        roomId: currentRoomId,
        isGroupCall: false,
        status: "ringing",
      }

      socket.emit("BE-initiate-call", {
        ...callData,
        targetUserId: currentChatUser._id,
      })

      // Show outgoing call UI to caller
      setOutgoingCall(callData)

      // Play ring sound for caller
      if (ringAudio) {
        try {
          if (ringAudio.currentTime !== undefined) {
            ringAudio.currentTime = 0
          }
          const playPromise = ringAudio.play()
          if (playPromise !== undefined) {
            playPromise.catch(console.error)
          }
        } catch (error) {
          console.error("Error playing ring sound:", error)
        }
      }
    }
  }

  const handleAudioCall = () => {
    if (currentChatUser && socket && socket.connected) {
      // Check if the user is already in a call
      if (isInCall || currentCall || incomingCall || outgoingCall) {
        alert("You are already in a call. Please end the current call before starting a new one.")
        return
      }

      const callData = {
        callId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        caller: user,
        receiver: currentChatUser,
        callType: "audio",
        roomId: currentRoomId,
        isGroupCall: false,
        status: "ringing",
      }

      socket.emit("BE-initiate-call", {
        ...callData,
        targetUserId: currentChatUser._id,
      })

      // Show outgoing call UI to caller
      setOutgoingCall(callData)

      // Play ring sound for caller
      if (ringAudio) {
        try {
          if (ringAudio.currentTime !== undefined) {
            ringAudio.currentTime = 0
          }
          const playPromise = ringAudio.play()
          if (playPromise !== undefined) {
            playPromise.catch(console.error)
          }
        } catch (error) {
          console.error("Error playing ring sound:", error)
        }
      }
    }
  }

  const handleGroupVideoCall = () => {
    if (currentGroup && socket && socket.connected) {
      // Check if the user is already in a call
      if (isInCall || currentCall || incomingCall || outgoingCall) {
        alert("You are already in a call. Please end the current call before starting a new one.")
        return
      }

      const callData = {
        callId: `group_call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        caller: user,
        groupName: currentGroup.name,
        callType: "video",
        groupId: currentGroup._id,
        isGroupCall: true,
        status: "ringing",
      }

      socket.emit("BE-initiate-group-call", {
        ...callData,
        groupId: currentGroup._id,
      })

      // Show outgoing call UI to caller
      setOutgoingCall(callData)

      // Play ring sound for caller
      if (ringAudio) {
        try {
          if (ringAudio.currentTime !== undefined) {
            ringAudio.currentTime = 0
          }
          const playPromise = ringAudio.play()
          if (playPromise !== undefined) {
            playPromise.catch(console.error)
          }
        } catch (error) {
          console.error("Error playing ring sound:", error)
        }
      }
    }
  }

  const handleGroupAudioCall = () => {
    if (currentGroup && socket && socket.connected) {
      // Check if the user is already in a call
      if (isInCall || currentCall || incomingCall || outgoingCall) {
        alert("You are already in a call. Please end the current call before starting a new one.")
        return
      }

      const callData = {
        callId: `group_call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        caller: user,
        groupName: currentGroup.name,
        callType: "audio",
        groupId: currentGroup._id,
        isGroupCall: true,
        status: "ringing",
      }

      socket.emit("BE-initiate-group-call", {
        ...callData,
        groupId: currentGroup._id,
      })

      // Show outgoing call UI to caller
      setOutgoingCall(callData)

      // Play ring sound for caller
      if (ringAudio) {
        try {
          if (ringAudio.currentTime !== undefined) {
            ringAudio.currentTime = 0
          }
          const playPromise = ringAudio.play()
          if (playPromise !== undefined) {
            playPromise.catch(console.error)
          }
        } catch (error) {
          console.error("Error playing ring sound:", error)
        }
      }
    }
  }

  const handleAcceptCall = () => {
    if (incomingCall && socket && socket.connected) {
      socket.emit("BE-accept-call", {
        callId: incomingCall.callId,
        callType: incomingCall.callType,
      })

      // Stop ring sound
      if (ringAudio && ringAudio.pause) {
        ringAudio.pause()
        if (ringAudio.currentTime !== undefined) {
          ringAudio.currentTime = 0
        }
      }

      setCurrentCall(incomingCall)
      setIncomingCall(null)
      setIsInCall(true)
    }
  }

  const handleRejectCall = () => {
    if (incomingCall && socket && socket.connected) {
      socket.emit("BE-reject-call", {
        callId: incomingCall.callId,
      })

      // Stop ring sound
      if (ringAudio && ringAudio.pause) {
        ringAudio.pause()
        if (ringAudio.currentTime !== undefined) {
          ringAudio.currentTime = 0
        }
      }

      setIncomingCall(null)
    }
  }

  const handleEndCall = () => {
    if (socket && socket.connected) {
      if (currentCall) {
        socket.emit("BE-end-call", {
          callId: currentCall.callId,
        })
        setCurrentCall(null)
        setIsInCall(false)
      }

      if (outgoingCall) {
        socket.emit("BE-end-call", {
          callId: outgoingCall.callId,
        })
        setOutgoingCall(null)
      }
    }

    // Stop ring sound
    if (ringAudio && ringAudio.pause) {
      ringAudio.pause()
      if (ringAudio.currentTime !== undefined) {
        ringAudio.currentTime = 0
      }
    }
  }

  const currentGroupData = groups.find((g) => g._id === currentGroup?._id) || currentGroup
  const isAdmin = currentGroupData?.creator._id === user.id

  if (isInCall && currentCall) {
    return <CallInterface call={currentCall} user={user} socket={socket} onEndCall={handleEndCall} />
  }

  if (showCallHistory) {
    return (
      <CallHistory
        callHistory={callHistory}
        currentUser={user}
        onBack={() => setShowCallHistory(false)}
        onCall={(targetUser, callType) => {
          setShowCallHistory(false)
          // Find and select the user first
          const foundUser = users.find((u) => u._id === targetUser._id)
          if (foundUser) {
            handleUserSelect(foundUser)
            // Then initiate call after a short delay
            setTimeout(() => {
              if (callType === "video") {
                handleVideoCall()
              } else {
                handleAudioCall()
              }
            }, 500)
          }
        }}
      />
    )
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <div className="bg-white shadow-sm p-4 border-b flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">PreeTalk</h1>
            <div className="text-sm text-gray-600">
              Welcome, {user.name} ({user.email})
            </div>
          </div>
          <button
            onClick={() => setShowCallHistory(true)}
            className="p-2 rounded-full hover:bg-gray-100 transition-colors"
            title="Call History"
          >
            <History className="w-6 h-6 text-gray-600" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Sidebar */}
        <div className="w-80 bg-white border-r flex flex-col min-h-0">
          <GroupList
            groups={groups}
            currentGroup={currentGroup}
            onGroupSelect={handleGroupSelect}
            onOpenGroupModal={() => setIsGroupModalOpen(true)}
            users={users}
            isCreatingGroup={isCreatingGroup}
            onGroupVideoCall={handleGroupVideoCall}
            onGroupAudioCall={handleGroupAudioCall}
          />
          <UsersList users={users} currentChatUser={currentChatUser} onUserSelect={handleUserSelect} />
        </div>

        {/* Chat Area */}
        <div className="flex-1 flex flex-col min-h-0">
          {isGroupChat && currentGroupData ? (
            <GroupChat
              group={currentGroupData}
              messages={chatHistories[currentRoomId] || []}
              currentUser={user}
              sendMessage={sendMessage}
              message={message}
              setMessage={setMessage}
              isAdmin={isAdmin}
              onVideoCall={handleGroupVideoCall}
              onAudioCall={handleGroupAudioCall}
            />
          ) : currentRoomId && currentChatUser ? (
            <>
              <div className="bg-white p-4 border-b flex-shrink-0">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">{currentChatUser.name}</h2>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAudioCall}
                      className="p-2 rounded-full hover:bg-gray-100 transition-colors"
                      title="Audio Call"
                    >
                      <Phone className="w-5 h-5 text-blue-600" />
                    </button>
                    <button
                      onClick={handleVideoCall}
                      className="p-2 rounded-full hover:bg-gray-100 transition-colors"
                      title="Video Call"
                    >
                      <Video className="w-5 h-5 text-blue-600" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 min-h-0">
                <MessageList messages={chatHistories[currentRoomId] || []} currentUser={user} />
              </div>

              {/* Input */}
              <div className="bg-white p-4 border-t flex-shrink-0">
                <ChatInput
                  message={message}
                  setMessage={setMessage}
                  sendMessage={sendMessage}
                  disabled={!currentRoomId}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center bg-gray-50">
              <p className="text-gray-500">Select a user or group to start chatting</p>
            </div>
          )}
        </div>
      </div>

      {/* Call Notifications */}
      {incomingCall && <CallNotification call={incomingCall} onAccept={handleAcceptCall} onReject={handleRejectCall} />}
      {outgoingCall && <OutgoingCall call={outgoingCall} onEndCall={handleEndCall} />}

      {/* Call Engaged Message */}
      {callEngagedMessage && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 text-center">
            <div className="text-red-500 text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold mb-2">Call Engaged</h2>
            <p className="text-gray-700 mb-4">{callEngagedMessage.userName} is currently on another call.</p>
            <button
              onClick={() => setCallEngagedMessage(null)}
              className="bg-blue-500 text-white py-2 px-4 rounded hover:bg-blue-600"
            >
              OK
            </button>
          </div>
        </div>
      )}

      <GroupModal
        users={users}
        currentUser={user}
        isOpen={isGroupModalOpen}
        onClose={() => setIsGroupModalOpen(false)}
        onCreateGroup={handleCreateGroup}
      />
    </div>
  )
}
