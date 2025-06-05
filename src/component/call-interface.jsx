import { useEffect, useRef, useState, useCallback } from "react"
import { PhoneOff, Mic, MicOff, Video, VideoOff, Users, ExternalLink } from "lucide-react"

export const CallInterface = ({ call, user, socket, onEndCall }) => {
  const localVideoRef = useRef(null)
  const localStreamRef = useRef(null)
  const audioElementsRef = useRef({})
  const jitsiContainerRef = useRef(null)
  const jitsiApiRef = useRef(null)

  // P2P refs for 1-on-1 calls
  const peerConnectionsRef = useRef({})

  const [isAudioEnabled, setIsAudioEnabled] = useState(true)
  const [isVideoEnabled, setIsVideoEnabled] = useState(call.callType === "video")
  const [callDuration, setCallDuration] = useState(0)
  const [remoteStreams, setRemoteStreams] = useState({})
  const [remoteUserStates, setRemoteUserStates] = useState({})
  const [gridLayout, setGridLayout] = useState("grid-cols-1")
  const [isConnecting, setIsConnecting] = useState(true)
  const [showDebugInfo, setShowDebugInfo] = useState(false)
  const [debugMessages, setDebugMessages] = useState([])
  const [allParticipants, setAllParticipants] = useState([])
  const [jitsiLoaded, setJitsiLoaded] = useState(false)
  const [jitsiRoomName, setJitsiRoomName] = useState("")

  const logDebug = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
    console.log(`[${timestamp}] ${message}`, data || "")
    setDebugMessages((prev) => [...prev.slice(-20), { time: timestamp, message }])
  }, [])

  // Calculate grid layout for P2P calls only
  useEffect(() => {
    if (call.isGroupCall) return // Jitsi handles its own layout

    const totalParticipants = allParticipants.length + 1
    if (totalParticipants <= 1) setGridLayout("grid-cols-1")
    else if (totalParticipants === 2) setGridLayout("grid-cols-1 md:grid-cols-2")
    else if (totalParticipants <= 4) setGridLayout("grid-cols-2")
    else setGridLayout("grid-cols-4")
  }, [allParticipants, call.isGroupCall])

  // Initialize call
  useEffect(() => {
    initializeCall()
    const timer = setInterval(() => setCallDuration((prev) => prev + 1), 1000)
    return () => {
      clearInterval(timer)
      cleanup()
    }
  }, [])

  // Load Jitsi Meet API only for group calls
  useEffect(() => {
    if (call.isGroupCall && !jitsiLoaded) {
      loadJitsiMeetAPI()
    }
  }, [call.isGroupCall, jitsiLoaded])

  // Socket listeners
  useEffect(() => {
    if (!socket) return

    socket.on("FE-call-participants", ({ participants }) => {
      logDebug("Received participants:", participants)
      setAllParticipants(participants || [])
      setIsConnecting(false)

      // For 1-on-1 calls ONLY, create P2P connection
      if (!call.isGroupCall && participants && participants.length > 0) {
        const otherUser = participants[0]
        setTimeout(() => createPeerConnection(otherUser._id || otherUser.id, otherUser, false), 500)
      }
    })

    socket.on("FE-user-joined-call", ({ userId, userInfo }) => {
      logDebug(`User joined: ${userId}`)
      setRemoteUserStates((prev) => ({
        ...prev,
        [userId]: { audio: true, video: call.callType === "video" },
      }))

      // For 1-on-1 calls ONLY, create P2P connection
      if (!call.isGroupCall) {
        setTimeout(() => createPeerConnection(userId, userInfo, true), 500)
      }
    })

    socket.on("FE-user-left-call", ({ userId }) => {
      logDebug(`User left: ${userId}`)
      if (!call.isGroupCall) {
        cleanupUser(userId)
      }
    })

    socket.on("FE-track-state-changed", ({ from, trackType, enabled }) => {
      // Only for P2P calls
      if (!call.isGroupCall) {
        setRemoteUserStates((prev) => ({
          ...prev,
          [from]: { ...prev[from], [trackType]: enabled },
        }))
      }
    })

    // P2P WebRTC events (for 1-on-1 calls ONLY)
    socket.on("FE-webrtc-offer", async ({ from, offer }) => {
      if (!call.isGroupCall) {
        await handleOffer(from, offer)
      }
    })

    socket.on("FE-webrtc-answer", async ({ from, answer }) => {
      if (!call.isGroupCall) {
        await handleAnswer(from, answer)
      }
    })

    socket.on("FE-webrtc-ice-candidate", async ({ from, candidate }) => {
      if (!call.isGroupCall) {
        await handleIceCandidate(from, candidate)
      }
    })

    // Jitsi room info (for group calls ONLY)
    socket.on("FE-jitsi-room-created", ({ roomName }) => {
      if (call.isGroupCall) {
        logDebug("Jitsi room created:", roomName)
        setJitsiRoomName(roomName)
        if (jitsiLoaded) {
          initializeJitsiMeet(roomName)
        } else {
          setTimeout(() => {
            if (!jitsiLoaded) {
              logDebug("Jitsi not loaded, providing fallback link")
              setDebugMessages((prev) => [
                ...prev,
                { time: new Date().toISOString().split("T")[1].split(".")[0], message: "Jitsi Meet not loaded. Use the 'Open in Browser' link." },
              ])
            }
          }, 30000)
        }
      }
    })

    return () => {
      const events = [
        "FE-call-participants",
        "FE-user-joined-call",
        "FE-user-left-call",
        "FE-track-state-changed",
        "FE-webrtc-offer",
        "FE-webrtc-answer",
        "FE-webrtc-ice-candidate",
        "FE-jitsi-room-created",
      ]
      events.forEach((event) => socket.off(event))
    }
  }, [socket, call.isGroupCall, call.callId, call.callType, jitsiLoaded])

  const loadJitsiMeetAPI = () => {
    if (window.JitsiMeetExternalAPI) {
      setJitsiLoaded(true)
      return
    }

    let retries = 0
    const maxRetries = 3

    const loadScript = () => {
      logDebug(`Loading Jitsi Meet API for group call... (Attempt ${retries + 1})`)
      const script = document.createElement("script")
      script.src = "https://meet.jit.si/external_api.js"
      script.async = true
      script.onload = () => {
        logDebug("Jitsi Meet API loaded")
        setJitsiLoaded(true)
        if (jitsiRoomName) {
          initializeJitsiMeet(jitsiRoomName)
        }
      }
      script.onerror = () => {
        retries++
        logDebug(`Failed to load Jitsi Meet API (Attempt ${retries})`)
        if (retries < maxRetries) {
          setTimeout(loadScript, 5000) // Retry after 5 seconds
        } else {
          logDebug("Failed to load Jitsi Meet API after maximum retries")
          setDebugMessages((prev) => [
            ...prev,
            { time: new Date().toISOString().split("T")[1].split(".")[0], message: "Error: Unable to load Jitsi Meet after multiple attempts. Use the 'Open in Browser' link." },
          ])
        }
      }
      document.head.appendChild(script)
    }

    loadScript()
  }

  const initializeJitsiMeet = (roomName) => {
    if (!window.JitsiMeetExternalAPI || !jitsiContainerRef.current) return

    logDebug("Initializing Jitsi Meet with room:", roomName)

    // Clean up existing API instance
    if (jitsiApiRef.current) {
      try {
        jitsiApiRef.current.dispose()
        jitsiApiRef.current = null
      } catch (error) {
        logDebug("Error disposing Jitsi API:", error)
      }
    }

    // Clear container
    if (jitsiContainerRef.current) {
      jitsiContainerRef.current.innerHTML = ""
      jitsiContainerRef.current.style.minHeight = "400px"
      jitsiContainerRef.current.style.width = "100%"
      jitsiContainerRef.current.style.height = "100%"
    }

    const options = {
      roomName: roomName,
      width: "100%",
      height: "100%",
      parentNode: jitsiContainerRef.current,
      configOverwrite: {
        startWithAudioMuted: !isAudioEnabled,
        startWithVideoMuted: call.callType === "audio" || !isVideoEnabled,
        prejoinPageEnabled: false,
        disableModeratorIndicator: true,
        startScreenSharing: false,
        enableEmailInStats: false,
        enableWelcomePage: false,
        enableClosePage: false,
        disableJoinLeaveSounds: true,
        enableNoAudioDetection: false,
        enableNoisyMicDetection: false,
      },
      interfaceConfigOverwrite: {
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
        DISABLE_PRESENCE_STATUS: true,
        DISABLE_DOMINANT_SPEAKER_INDICATOR: true,
        HIDE_INVITE_MORE_HEADER: true,
        SHOW_JITSI_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false,
        SHOW_BRAND_WATERMARK: false,
        BRAND_WATERMARK_LINK: "",
        SHOW_POWERED_BY: false,
        DISPLAY_WELCOME_PAGE_CONTENT: false,
        DISPLAY_WELCOME_PAGE_TOOLBAR_ADDITIONAL_CONTENT: false,
        SHOW_CHROME_EXTENSION_BANNER: false,
        MOBILE_APP_PROMO: false,
        TOOLBAR_BUTTONS: [
          "microphone",
          "camera",
          "closedcaptions",
          "desktop",
          "fullscreen",
          "fodeviceselection",
          "hangup",
          "profile",
          "chat",
          "recording",
          "livestreaming",
          "etherpad",
          "sharedvideo",
          "settings",
          "raisehand",
          "videoquality",
          "filmstrip",
          "invite",
          "feedback",
          "stats",
          "shortcuts",
          "tileview",
          "videobackgroundblur",
          "download",
          "help",
          "mute-everyone",
        ],
      },
      userInfo: {
        displayName: user.name,
        email: user.email,
      },
    }

    try {
      jitsiApiRef.current = new window.JitsiMeetExternalAPI("meet.jit.si", options)

      // Event listeners
      jitsiApiRef.current.addEventListener("videoConferenceJoined", (participant) => {
        logDebug("Successfully joined Jitsi conference:", participant.displayName)
        setIsConnecting(false)
      })

      jitsiApiRef.current.addEventListener("participantJoined", (participant) => {
        logDebug("Participant joined Jitsi:", participant.displayName)
      })

      jitsiApiRef.current.addEventListener("participantLeft", (participant) => {
        logDebug("Participant left Jitsi:", participant.displayName)
      })

      jitsiApiRef.current.addEventListener("audioMuteStatusChanged", ({ muted }) => {
        setIsAudioEnabled(!muted)
      })

      jitsiApiRef.current.addEventListener("videoMuteStatusChanged", ({ muted }) => {
        setIsVideoEnabled(!muted)
      })

      jitsiApiRef.current.addEventListener("readyToClose", () => {
        logDebug("Jitsi ready to close")
        onEndCall()
      })

      logDebug("Jitsi Meet initialized successfully")
    } catch (error) {
      logDebug("Error initializing Jitsi Meet:", error)
    }
  }

  const initializeCall = async () => {
    try {
      if (call.isGroupCall) {
        logDebug("Initializing group call with Jitsi Meet...")
        // Request Jitsi room creation
        socket.emit("BE-create-jitsi-room", { callId: call.callId })
        setIsConnecting(false)
        return
      }

      // For 1-on-1 calls, get user media for P2P
      logDebug("Getting user media for P2P call...")

      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: call.callType === "video" ? { width: 640, height: 480 } : false,
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      localStreamRef.current = stream

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
        localVideoRef.current.muted = true
      }

      logDebug("Local media obtained for P2P")

      const otherUserId = call.caller.id === user.id ? call.receiver._id : call.caller._id
      const otherUserInfo = call.caller.id === user.id ? call.receiver : call.caller
      setAllParticipants([otherUserInfo])
      setIsConnecting(false)
      setTimeout(() => createPeerConnection(otherUserId, otherUserInfo, call.caller.id === user.id), 1000)

      // Get participants
      socket.emit("BE-get-call-participants", { callId: call.callId })
    } catch (error) {
      logDebug("Error initializing call:", error)
      alert("Could not access microphone/camera")
      onEndCall()
    }
  }

  // P2P Functions (for 1-on-1 calls ONLY)
  const createPeerConnection = async (userId, userInfo, shouldOffer) => {
    try {
      logDebug(`Creating P2P connection for ${userId}`)

      if (peerConnectionsRef.current[userId]) {
        return
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      })

      peerConnectionsRef.current[userId] = pc

      // Add local tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current)
        })
      }

      // Handle remote tracks
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams
        if (remoteStream) {
          setRemoteStreams((prev) => ({ ...prev, [userId]: remoteStream }))
          if (event.track.kind === "audio") {
            setupAudioPlayback(remoteStream, userId)
          }
        }
      }

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("BE-webrtc-ice-candidate", {
            to: userId,
            candidate: event.candidate,
            callId: call.callId,
          })
        }
      }

      // Create offer if needed
      if (shouldOffer) {
        setTimeout(async () => {
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            socket.emit("BE-webrtc-offer", {
              to: userId,
              offer,
              callId: call.callId,
            })
          } catch (error) {
            logDebug("Error creating offer:", error)
          }
        }, 1000)
      }
    } catch (error) {
      logDebug("Error creating peer connection:", error)
    }
  }

  const handleOffer = async (userId, offer) => {
    try {
      let pc = peerConnectionsRef.current[userId]
      if (!pc) {
        await createPeerConnection(userId, null, false)
        pc = peerConnectionsRef.current[userId]
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      socket.emit("BE-webrtc-answer", {
        to: userId,
        answer,
        callId: call.callId,
      })
    } catch (error) {
      logDebug("Error handling offer:", error)
    }
  }

  const handleAnswer = async (userId, answer) => {
    try {
      const pc = peerConnectionsRef.current[userId]
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer))
      }
    } catch (error) {
      logDebug("Error handling answer:", error)
    }
  }

  const handleIceCandidate = async (userId, candidate) => {
    try {
      const pc = peerConnectionsRef.current[userId]
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      }
    } catch (error) {
      logDebug("Error handling ICE candidate:", error)
    }
  }

  // Audio playback setup for P2P
  const setupAudioPlayback = async (stream, userId) => {
    try {
      logDebug(`Setting up audio for ${userId}`)

      if (audioElementsRef.current[userId]) {
        audioElementsRef.current[userId].pause()
        audioElementsRef.current[userId].srcObject = null
      }

      const audioElement = new Audio()
      audioElement.srcObject = stream
      audioElement.autoplay = true
      audioElement.volume = 1.0
      audioElement.muted = false

      audioElement.style.display = "none"
      document.body.appendChild(audioElement)
      audioElementsRef.current[userId] = audioElement

      try {
        await audioElement.play()
        logDebug(`Audio playing for ${userId}`)
      } catch (playError) {
        logDebug(`Audio play failed, will retry on user interaction`)
        const retryPlay = async () => {
          try {
            await audioElement.play()
            logDebug(`Audio retry successful for ${userId}`)
          } catch (e) {
            logDebug(`Audio retry failed for ${userId}`)
          }
        }
        document.addEventListener("click", retryPlay, { once: true })
      }
    } catch (error) {
      logDebug(`Error setting up audio for ${userId}:`, error)
    }
  }

  // Cleanup functions
  const cleanupUser = (userId) => {
    // P2P cleanup
    if (peerConnectionsRef.current[userId]) {
      peerConnectionsRef.current[userId].close()
      delete peerConnectionsRef.current[userId]
    }

    // Audio cleanup
    if (audioElementsRef.current[userId]) {
      audioElementsRef.current[userId].pause()
      audioElementsRef.current[userId].srcObject = null
      if (audioElementsRef.current[userId].parentNode) {
        audioElementsRef.current[userId].parentNode.removeChild(audioElementsRef.current[userId])
      }
      delete audioElementsRef.current[userId]
    }

    // Remove from streams
    setRemoteStreams((prev) => {
      const newStreams = { ...prev }
      delete newStreams[userId]
      return newStreams
    })
  }

  const cleanup = () => {
    // Cleanup Jitsi (group calls)
    if (jitsiApiRef.current) {
      jitsiApiRef.current.dispose()
      jitsiApiRef.current = null
    }

    // Cleanup P2P (1-on-1 calls)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
    }

    Object.values(peerConnectionsRef.current).forEach((pc) => pc?.close())
    peerConnectionsRef.current = {}

    Object.values(audioElementsRef.current).forEach((audio) => {
      audio.pause()
      audio.srcObject = null
      if (audio.parentNode) audio.parentNode.removeChild(audio)
    })
    audioElementsRef.current = {}
  }

  const toggleAudio = () => {
    if (call.isGroupCall && jitsiApiRef.current) {
      // For Jitsi group calls
      jitsiApiRef.current.executeCommand("toggleAudio")
    } else {
      // For P2P 1-on-1 calls
      if (!localStreamRef.current) return

      const newState = !isAudioEnabled
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = newState
      })
      setIsAudioEnabled(newState)

      allParticipants.forEach((participant) => {
        socket.emit("BE-track-state-changed", {
          to: participant._id || participant.id,
          trackType: "audio",
          enabled: newState,
          callId: call.callId,
        })
      })
    }
  }

  const toggleVideo = () => {
    if (call.callType !== "video") return

    if (call.isGroupCall && jitsiApiRef.current) {
      // For Jitsi group calls
      jitsiApiRef.current.executeCommand("toggleVideo")
    } else {
      // For P2P 1-on-1 calls
      if (!localStreamRef.current) return

      const newState = !isVideoEnabled
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = newState
      })
      setIsVideoEnabled(newState)

      allParticipants.forEach((participant) => {
        socket.emit("BE-track-state-changed", {
          to: participant._id || participant.id,
          trackType: "video",
          enabled: newState,
          callId: call.callId,
        })
      })
    }
  }

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const totalParticipants = call.isGroupCall ? "Multiple" : allParticipants.length + 1

  if (call.isGroupCall) {
    // GROUP CALL UI - Jitsi Meet
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        {/* Header */}
        <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Group {call.callType} call</h2>
            <p className="text-sm text-gray-300">{formatDuration(callDuration)} • Jitsi Meet</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-300 flex items-center">
              <Users className="w-4 h-4 mr-1" />
              Group
            </span>
            {jitsiRoomName && (
              <a
                href={`https://meet.jit.si/${jitsiRoomName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs bg-blue-600 text-white px-2 py-1 rounded flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" />
                Open in Browser
              </a>
            )}
            <button
              onClick={() => setShowDebugInfo(!showDebugInfo)}
              className="text-xs bg-gray-600 text-white px-2 py-1 rounded"
            >
              Debug
            </button>
            <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
              <PhoneOff className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Debug Info */}
        {showDebugInfo && (
          <div className="bg-black text-green-400 p-2 text-xs max-h-32 overflow-y-auto">
            <div className="mb-2">
              <strong>Mode:</strong> Jitsi Meet (Group Call) | <strong>Room:</strong> {jitsiRoomName || "Creating..."}
            </div>
            <div className="mb-2">
              <strong>Jitsi Loaded:</strong> {jitsiLoaded ? "✓" : "✗"} | <strong>API Ready:</strong>{" "}
              {jitsiApiRef.current ? "✓" : "✗"}
            </div>
            <div className="space-y-1">
              {debugMessages.slice(-5).map((msg, idx) => (
                <div key={idx}>
                  [{msg.time}] {msg.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Jitsi Meet Container */}
        <div className="flex-1 relative">
          {!jitsiLoaded && debugMessages.some(msg => msg.message.includes("Error: Unable to load Jitsi Meet")) ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-white">
                <p className="text-red-500">Failed to load Jitsi Meet</p>
                <p className="text-sm text-gray-400 mt-2">Please check your internet connection or use the 'Open in Browser' link.</p>
              </div>
            </div>
          ) : !jitsiLoaded || !jitsiRoomName ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-white">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
                <p>Loading Jitsi Meet...</p>
                <p className="text-sm text-gray-400 mt-2">Setting up group call room</p>
              </div>
            </div>
          ) : (
            <div
              ref={jitsiContainerRef}
              className="w-full h-full min-h-[400px] bg-black"
              style={{ minHeight: "400px" }}
            />
          )}
        </div>
      </div>
    )
  }

  // P2P CALL UI (for 1-on-1 calls)
  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {/* Header */}
      <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{call.callType} call</h2>
          <p className="text-sm text-gray-300">
            {formatDuration(callDuration)} • {totalParticipants} participant{totalParticipants !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-300 flex items-center">
            <Users className="w-4 h-4 mr-1" />
            {totalParticipants}
          </span>
          <button
            onClick={() => setShowDebugInfo(!showDebugInfo)}
            className="text-xs bg-gray-600 text-white px-2 py-1 rounded"
          >
            Debug
          </button>
          <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Debug Info */}
      {showDebugInfo && (
        <div className="bg-black text-green-400 p-2 text-xs max-h-32 overflow-y-auto">
          <div className="mb-2">
            <strong>Mode:</strong> P2P (1-on-1) | <strong>Participants ({allParticipants.length}):</strong>{" "}
            {allParticipants.map((p) => p.name).join(", ")}
          </div>
          <div className="mb-2">
            <strong>Remote Streams:</strong> {Object.keys(remoteStreams).length} | <strong>Audio Elements:</strong>{" "}
            {Object.keys(audioElementsRef.current).length}
          </div>
          <div className="mb-2">
            <strong>P2P Connections:</strong> {Object.keys(peerConnectionsRef.current).length}
          </div>
          <div className="space-y-1">
            {debugMessages.slice(-5).map((msg, idx) => (
              <div key={idx}>
                [{msg.time}] {msg.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Video Grid */}
      <div className="flex-1 p-2">
        <div className={`grid gap-2 h-full ${gridLayout}`}>
          {/* Remote participants */}
          {allParticipants.map((participant) => {
            const userId = participant._id || participant.id
            const userState = remoteUserStates[userId] || { audio: true, video: true }
            const stream = remoteStreams[userId]

            return (
              <div
                key={userId}
                className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center"
              >
                <video
                  ref={(el) => {
                    if (el && stream) {
                      el.srcObject = stream
                      el.play().catch(console.error)
                    }
                  }}
                  autoPlay
                  playsInline
                  className={`w-full h-full object-cover ${call.callType === "video" && userState.video ? "" : "hidden"}`}
                />

                {(!stream || call.callType === "audio" || !userState.video) && (
                  <div className="w-16 h-16 bg-blue-500 text-white rounded-full flex items-center justify-center text-xl font-bold">
                    {(participant.name || "U").charAt(0).toUpperCase()}
                  </div>
                )}

                <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded">
                  {participant.name || "User"}
                  {!userState.audio && " (Muted)"}
                </div>

                <div
                  className={`absolute top-2 left-2 w-3 h-3 rounded-full ${userState.audio ? "bg-green-500" : "bg-gray-500"}`}
                />
              </div>
            )
          })}

          {/* Local user */}
          <div className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${call.callType === "audio" || !isVideoEnabled ? "hidden" : ""}`}
            />

            {(call.callType === "audio" || !isVideoEnabled) && (
              <div className="w-16 h-16 bg-blue-500 text-white rounded-full flex items-center justify-center text-xl font-bold">
                {user.name.charAt(0).toUpperCase()}
              </div>
            )}

            <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded">
              You {!isAudioEnabled && "(Muted)"}
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="p-4 flex justify-center gap-4">
        <button
          onClick={toggleAudio}
          className={`p-3 rounded-full ${
            isAudioEnabled ? "bg-blue-500 hover:bg-blue-600" : "bg-red-500 hover:bg-red-600"
          } text-white transition-colors`}
        >
          {isAudioEnabled ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
        </button>

        {call.callType === "video" && (
          <button
            onClick={toggleVideo}
            className={`p-3 rounded-full ${
              isVideoEnabled ? "bg-blue-500 hover:bg-blue-600" : "bg-red-600 hover:bg-red-700"
            } text-white transition-colors`}
          >
            {isVideoEnabled ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
          </button>
        )}

        <button
          onClick={onEndCall}
          className="p-3 rounded-full bg-red-500 hover:bg-red-600 text-white transition-colors"
        >
          <PhoneOff className="w-6 h-6" />
        </button>
      </div>
    </div>
  )
}