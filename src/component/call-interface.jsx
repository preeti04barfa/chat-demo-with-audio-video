import { useEffect, useRef, useState, useCallback } from "react"
import { PhoneOff, Mic, MicOff, Video, VideoOff, Users } from "lucide-react"

export function CallInterface({ call, user, socket, onEndCall }) {
  const localVideoRef = useRef(null)
  const remoteVideosRef = useRef({})
  const localStreamRef = useRef(null)
  const peerConnectionsRef = useRef({})
  const audioSendersRef = useRef({})
  const videoSendersRef = useRef({})
  const containerRef = useRef(null)

  // SFU-specific refs
  const isHubRef = useRef(false)
  const hubUserIdRef = useRef(null)
  const forwardingStreamsRef = useRef({})
  const forwardedTracksRef = useRef({}) 

  const connectionStatusRef = useRef({})
  const connectionTimersRef = useRef({})
  const reconnectAttemptsRef = useRef({})
  const processedParticipantsRef = useRef(new Set())
  const participantsMapRef = useRef(new Map())
  const iceCandidateBuffersRef = useRef({})
  const connectionEstablishedRef = useRef({})

  const [isAudioEnabled, setIsAudioEnabled] = useState(true)
  const [isVideoEnabled, setIsVideoEnabled] = useState(call.callType === "video")
  const [connectedUsers, setConnectedUsers] = useState([])
  const [callDuration, setCallDuration] = useState(0)
  const [remoteStreams, setRemoteStreams] = useState({})
  const [remoteUserStates, setRemoteUserStates] = useState({})
  const [gridLayout, setGridLayout] = useState("grid-cols-1")
  const [debugMessages, setDebugMessages] = useState([])

  // Logging function
  const logDebug = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage, data || "")

    setDebugMessages((prev) => {
      const newMessages = [...prev, { time: timestamp, message, data: JSON.stringify(data || "") }]
      return newMessages.slice(-50)
    })
  }, [])

  // Calculate grid layout
  useEffect(() => {
    const totalParticipants = Object.keys(remoteStreams).length + 1

    if (totalParticipants <= 1) {
      setGridLayout("grid-cols-1")
    } else if (totalParticipants === 2) {
      setGridLayout("grid-cols-1 md:grid-cols-2")
    } else if (totalParticipants <= 4) {
      setGridLayout("grid-cols-2")
    } else if (totalParticipants <= 9) {
      setGridLayout("grid-cols-3")
    } else {
      setGridLayout("grid-cols-4")
    }
  }, [remoteStreams])

  // Initialize call
  useEffect(() => {
    initializeCall()

    const timer = setInterval(() => {
      setCallDuration((prev) => prev + 1)
    }, 1000)

    return () => {
      clearInterval(timer)
      cleanup()
    }
  }, [])

  // Socket event listeners
  useEffect(() => {
    if (!socket) return

    socket.on("FE-user-joined-call", ({ userId, userInfo }) => {
      logDebug(`User joined call: ${userId}`, userInfo)

      setConnectedUsers((prev) => {
        if (prev.some((u) => u._id === userId || u.id === userId)) {
          return prev
        }
        return [...prev, userInfo]
      })

      participantsMapRef.current.set(userId, userInfo)

      if (call.isGroupCall) {
        handleGroupCallParticipant(userId, userInfo)
      } else {
        // One-to-one call - direct P2P
        setTimeout(() => {
          createPeerConnection(userId, userInfo)
        }, 300)
      }
    })

    socket.on("FE-user-left-call", ({ userId }) => {
      logDebug(`User left call: ${userId}`)

      setConnectedUsers((prev) => prev.filter((u) => u._id !== userId && u.id !== userId))
      participantsMapRef.current.delete(userId)
      processedParticipantsRef.current.delete(userId)

      cleanupPeerConnection(userId)

      // If the hub left, elect new hub
      if (call.isGroupCall && hubUserIdRef.current === userId) {
        electNewHub()
      }

      if (connectionTimersRef.current[userId]) {
        clearTimeout(connectionTimersRef.current[userId])
        delete connectionTimersRef.current[userId]
      }

      delete reconnectAttemptsRef.current[userId]
      delete connectionStatusRef.current[userId]
      delete connectionEstablishedRef.current[userId]
    })

    socket.on("FE-existing-participants", ({ participants }) => {
      logDebug(`Received ${participants.length} existing participants`, participants)

      if (call.isGroupCall) {
        processedParticipantsRef.current.clear()
        processedParticipantsRef.current.add(user.id)

        const newConnectedUsers = []

        participants.forEach((participant) => {
          if (participant.userId !== user.id) {
            processedParticipantsRef.current.add(participant.userId)
            participantsMapRef.current.set(participant.userId, participant.userInfo)
            newConnectedUsers.push(participant.userInfo)
          }
        })

        setConnectedUsers((prev) => {
          const existingIds = new Set(newConnectedUsers.map((u) => u.id || u._id))
          const filteredPrev = prev.filter((u) => !existingIds.has(u.id || u._id))
          return [...filteredPrev, ...newConnectedUsers]
        })

        // Determine hub and establish SFU connections
        setupSFUConnections(participants)
      }
    })

    socket.on("FE-hub-assignment", ({ hubUserId }) => {
      logDebug(`Hub assigned: ${hubUserId}`)
      const wasHub = isHubRef.current
      hubUserIdRef.current = hubUserId
      isHubRef.current = hubUserId === user.id

      if (isHubRef.current) {
        logDebug("I am the hub for this group call")
        // Initialize forwarded tracks tracking for all participants
        forwardedTracksRef.current = {}

        // If we just became the hub, establish connections with all participants
        if (!wasHub) {
          setTimeout(() => {
            establishHubConnections()
          }, 1000)
        }
      } else {
        logDebug(`Connecting to hub: ${hubUserId}`)
        // Clean up any existing connections except to the hub
        Object.keys(peerConnectionsRef.current).forEach((userId) => {
          if (userId !== hubUserId) {
            cleanupPeerConnection(userId)
          }
        })

        // Connect to hub
        const hubUserInfo = participantsMapRef.current.get(hubUserId)
        if (hubUserInfo) {
          createPeerConnection(hubUserId, hubUserInfo, true)
        }
      }
    })

    socket.on("FE-webrtc-offer", async ({ from, offer }) => {
      logDebug(`Received offer from: ${from}`, offer)
      await handleOffer(from, offer)
    })

    socket.on("FE-webrtc-answer", async ({ from, answer }) => {
      logDebug(`Received answer from: ${from}`, answer)
      await handleAnswer(from, answer)
    })

    socket.on("FE-webrtc-ice-candidate", async ({ from, candidate }) => {
      logDebug(`Received ICE candidate from: ${from}`, candidate)
      await handleIceCandidate(from, candidate)
    })

    socket.on("FE-track-state-changed", ({ from, trackType, enabled }) => {
      logDebug(`Track state changed from ${from}: ${trackType} = ${enabled}`)

      setRemoteUserStates((prev) => ({
        ...prev,
        [from]: {
          ...prev[from],
          [trackType]: enabled,
        },
      }))
    })

    return () => {
      socket.off("FE-user-joined-call")
      socket.off("FE-user-left-call")
      socket.off("FE-existing-participants")
      socket.off("FE-hub-assignment")
      socket.off("FE-webrtc-offer")
      socket.off("FE-webrtc-answer")
      socket.off("FE-webrtc-ice-candidate")
      socket.off("FE-track-state-changed")
    }
  }, [socket, call.isGroupCall, user.id, logDebug])

  const initializeCall = async () => {
    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 2,
        },
        video:
          call.callType === "video"
            ? {
                width: { ideal: 640, max: 1280 },
                height: { ideal: 480, max: 720 },
                facingMode: "user",
                frameRate: { ideal: 30, max: 30 },
              }
            : false,
      }

      logDebug("Requesting media with constraints:", constraints)
      const stream = await navigator.mediaDevices.getUserMedia(constraints)

      localStreamRef.current = stream

      stream.getAudioTracks().forEach((track) => {
        track.enabled = true
        logDebug("Local audio track enabled:", { enabled: track.enabled, readyState: track.readyState })
      })

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
        localVideoRef.current.muted = true
        localVideoRef.current.playsInline = true
        localVideoRef.current.autoplay = true
      }

      socket.emit("BE-join-call", {
        callId: call.callId,
        userId: user.id,
        userInfo: user,
      })

      if (call.isGroupCall) {
        processedParticipantsRef.current.add(user.id)
        participantsMapRef.current.set(user.id, user)

        setTimeout(() => {
          socket.emit("BE-get-call-participants", { callId: call.callId })
        }, 1000)
      } else {
        // One-to-one call setup
        const otherUserId = call.caller.id === user.id ? call.receiver._id : call.caller._id
        const otherUserInfo = call.caller.id === user.id ? call.receiver : call.caller

        setRemoteUserStates({
          [otherUserId]: {
            audio: true,
            video: call.callType === "video",
          },
        })

        setConnectedUsers([otherUserInfo])
        participantsMapRef.current.set(otherUserId, otherUserInfo)

        setTimeout(() => {
          createPeerConnection(otherUserId, otherUserInfo)
        }, 200)
      }
    } catch (error) {
      logDebug("Error accessing media devices:", error)
      alert("Could not access camera/microphone. Please check your permissions and try again.")
      onEndCall()
    }
  }

  const handleGroupCallParticipant = (userId, userInfo) => {
    if (!processedParticipantsRef.current.has(userId)) {
      processedParticipantsRef.current.add(userId)

      // If we're the hub, establish connection with this participant
      if (isHubRef.current) {
        logDebug(`As hub, establishing connection with ${userId}`)
        setTimeout(() => {
          createPeerConnection(userId, userInfo, false)
        }, 500)
      } else if (hubUserIdRef.current === userId) {
        // This is the hub joining, connect to them
        logDebug(`Hub ${userId} joined, connecting to them`)
        setTimeout(() => {
          createPeerConnection(userId, userInfo, true)
        }, 500)
      }
    }
  }

  const setupSFUConnections = (participants) => {
    // Elect hub (first participant by join time or user ID)
    const sortedParticipants = [...participants].sort((a, b) => {
      if (a.joinedAt && b.joinedAt) {
        return new Date(a.joinedAt) - new Date(b.joinedAt)
      }
      return a.userId.localeCompare(b.userId)
    })

    const hubUserId = sortedParticipants[0]?.userId

    if (hubUserId) {
      hubUserIdRef.current = hubUserId
      isHubRef.current = hubUserId === user.id

      logDebug(`Hub elected: ${hubUserId}, I am hub: ${isHubRef.current}`)

      // Notify server about hub assignment
      socket.emit("BE-hub-assignment", {
        callId: call.callId,
        hubUserId: hubUserId,
      })

      if (isHubRef.current) {
        // As hub, establish connections with all other participants
        setTimeout(() => {
          establishHubConnections()
        }, 1000)
      } else {
        // Connect to hub only
        const hubUserInfo = participantsMapRef.current.get(hubUserId)
        if (hubUserInfo) {
          setTimeout(() => {
            createPeerConnection(hubUserId, hubUserInfo, true)
          }, 1000)
        }
      }
    }
  }

  const establishHubConnections = () => {
    if (!isHubRef.current) return

    logDebug("Establishing hub connections with all participants")

    // Connect to all participants except ourselves
    Array.from(processedParticipantsRef.current).forEach((userId) => {
      if (userId !== user.id && !peerConnectionsRef.current[userId]) {
        const userInfo = participantsMapRef.current.get(userId)
        if (userInfo) {
          logDebug(`Hub establishing connection with ${userId}`)
          createPeerConnection(userId, userInfo, false)
        }
      }
    })
  }

  const electNewHub = () => {
    // Elect new hub from remaining participants
    const remainingParticipants = Array.from(processedParticipantsRef.current).filter(
      (id) => id !== hubUserIdRef.current && participantsMapRef.current.has(id),
    )

    if (remainingParticipants.length > 0) {
      const newHubUserId = remainingParticipants.sort()[0]
      hubUserIdRef.current = newHubUserId
      isHubRef.current = newHubUserId === user.id

      logDebug(`New hub elected: ${newHubUserId}, I am hub: ${isHubRef.current}`)

      // Notify all participants about new hub
      socket.emit("BE-hub-assignment", {
        callId: call.callId,
        hubUserId: newHubUserId,
      })

      if (isHubRef.current) {
        // We became the new hub, establish connections with all participants
        setTimeout(() => {
          establishHubConnections()
        }, 1000)
      } else {
        // Clean up old connections and connect to new hub
        Object.keys(peerConnectionsRef.current).forEach((userId) => {
          if (userId !== newHubUserId) {
            cleanupPeerConnection(userId)
          }
        })

        // Connect to new hub
        const hubUserInfo = participantsMapRef.current.get(newHubUserId)
        if (hubUserInfo) {
          setTimeout(() => {
            createPeerConnection(newHubUserId, hubUserInfo, true)
          }, 1000)
        }
      }
    }
  }

  const createPeerConnection = async (userId, userInfo, shouldInitiateOffer = null) => {
    try {
      if (peerConnectionsRef.current[userId]) {
        const existingConnection = peerConnectionsRef.current[userId].connection
        if (existingConnection.connectionState === "connected" || existingConnection.connectionState === "connecting") {
          logDebug(`Peer connection for user ${userId} already exists and is connecting/connected`)
          return existingConnection
        }
        logDebug(`Peer connection for user ${userId} exists but not connected, cleaning up first`)
        cleanupPeerConnection(userId)
      }

      logDebug(`Creating peer connection for user ${userId}`, { userInfo, shouldInitiateOffer })

      connectionStatusRef.current[userId] = "connecting"

      const configuration = {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" },
          {
            urls: "turn:numb.viagenie.ca",
            credential: "muazkh",
            username: "webrtc@live.com",
          },
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        sdpSemantics: "unified-plan",
      }

      const peerConnection = new RTCPeerConnection(configuration)

      iceCandidateBuffersRef.current[userId] = []

      peerConnectionsRef.current[userId] = {
        userId,
        connection: peerConnection,
        remoteDescriptionSet: false,
        localDescriptionSet: false,
        userInfo: userInfo || { id: userId, name: "User" },
        connectionState: "new",
        offerSent: false,
        answerSent: false,
        connectionAttempts: reconnectAttemptsRef.current[userId] || 0,
      }

      // Initialize forwarded tracks tracking for this connection
      if (isHubRef.current) {
        forwardedTracksRef.current[userId] = new Set()
      }

      // Add local stream tracks
      if (localStreamRef.current) {
        audioSendersRef.current[userId] = []
        videoSendersRef.current[userId] = []

        localStreamRef.current.getTracks().forEach((track) => {
          logDebug(`Adding ${track.kind} track to peer connection for ${userId}`)
          const sender = peerConnection.addTrack(track, localStreamRef.current)
          if (track.kind === "audio") {
            audioSendersRef.current[userId].push(sender)
          } else {
            videoSendersRef.current[userId].push(sender)
          }
        })
      }

      // If we're the hub, add all existing forwarded streams to this new connection
      if (isHubRef.current) {
        Object.entries(forwardingStreamsRef.current).forEach(([sourceUserId, stream]) => {
          if (sourceUserId !== userId) {
            addStreamToConnection(peerConnection, stream, userId, sourceUserId)
          }
        })
      }

      // Handle incoming tracks
      peerConnection.ontrack = (event) => {
        logDebug(`Received ${event.track.kind} track from ${userId}`)
        const [remoteStream] = event.streams

        if (remoteStream) {
          logDebug(`Setting remote stream for ${userId}`)

          // Store the stream
          setRemoteStreams((prev) => ({
            ...prev,
            [userId]: remoteStream,
          }))

          // If we're the hub, forward this stream to all other participants
          if (call.isGroupCall && isHubRef.current && userId !== user.id) {
            forwardingStreamsRef.current[userId] = remoteStream
            forwardStreamToAllOthers(userId, remoteStream)
          }

          setRemoteUserStates((prev) => ({
            ...prev,
            [userId]: {
              audio: true,
              video: call.callType === "video",
            },
          }))

          connectionEstablishedRef.current[userId] = true
          connectionStatusRef.current[userId] = "connected"
        }
      }

      // ICE candidate handling
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          logDebug(`Generated ICE candidate for ${userId}`, event.candidate)
          socket.emit("BE-webrtc-ice-candidate", {
            to: userId,
            candidate: event.candidate,
            callId: call.callId,
          })
        }
      }

      // Connection state monitoring
      peerConnection.oniceconnectionstatechange = () => {
        logDebug(`ICE connection state for ${userId}: ${peerConnection.iceConnectionState}`)

        if (peerConnectionsRef.current[userId]) {
          peerConnectionsRef.current[userId].connectionState = peerConnection.iceConnectionState
        }

        connectionStatusRef.current[userId] = peerConnection.iceConnectionState

        if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
          reconnectAttemptsRef.current[userId] = 0
          connectionEstablishedRef.current[userId] = true

          // If we're the hub and this connection just established, forward all existing streams
          if (isHubRef.current && call.isGroupCall) {
            setTimeout(() => {
              forwardAllExistingStreamsToParticipant(userId)
            }, 500)
          }

          if (iceCandidateBuffersRef.current[userId] && iceCandidateBuffersRef.current[userId].length > 0) {
            logDebug(
              `Processing ${iceCandidateBuffersRef.current[userId].length} buffered ICE candidates for ${userId}`,
            )

            const candidates = [...iceCandidateBuffersRef.current[userId]]
            iceCandidateBuffersRef.current[userId] = []

            candidates.forEach(async (candidate) => {
              try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                logDebug(`Added buffered ICE candidate for ${userId}`)
              } catch (e) {
                logDebug(`Error adding buffered ICE candidate for ${userId}:`, e)
              }
            })
          }
        }

        if (peerConnection.iceConnectionState === "failed" || peerConnection.iceConnectionState === "disconnected") {
          logDebug(`Connection to ${userId} ${peerConnection.iceConnectionState}, attempting restart`)

          if (!connectionTimersRef.current[userId]) {
            connectionTimersRef.current[userId] = setTimeout(() => {
              delete connectionTimersRef.current[userId]

              const attempts = reconnectAttemptsRef.current[userId] || 0
              if (attempts < 3) {
                reconnectAttemptsRef.current[userId] = attempts + 1
                logDebug(`Recreating connection to ${userId}, attempt ${attempts + 1}/3`)

                cleanupPeerConnection(userId)
                const userInfo = participantsMapRef.current.get(userId)
                if (userInfo) {
                  setTimeout(() => {
                    createPeerConnection(userId, userInfo, true)
                  }, 1000)
                }
              } else {
                logDebug(`Max reconnection attempts reached for ${userId}`)
                connectionStatusRef.current[userId] = "failed"
              }
            }, 3000)
          }
        }
      }

      peerConnection.onconnectionstatechange = () => {
        logDebug(`Connection state for ${userId}: ${peerConnection.connectionState}`)

        if (peerConnectionsRef.current[userId]) {
          peerConnectionsRef.current[userId].connectionState = peerConnection.connectionState
        }

        if (peerConnection.connectionState === "connected") {
          reconnectAttemptsRef.current[userId] = 0
          connectionEstablishedRef.current[userId] = true
          connectionStatusRef.current[userId] = "connected"
        }
      }

      // Determine who should create offer
      if (call.isGroupCall) {
        // In SFU mode: non-hub participants initiate offers to hub, hub accepts from all
        shouldInitiateOffer = !isHubRef.current && userId === hubUserIdRef.current
      } else {
        // One-to-one: caller creates offer
        shouldInitiateOffer = call.caller.id === user.id
      }

      if (shouldInitiateOffer) {
        peerConnectionsRef.current[userId].offerSent = true
        setTimeout(
          () => {
            if (peerConnection.signalingState === "stable") {
              createOffer(userId, peerConnection)
            }
          },
          500 + Math.random() * 1000,
        )
      }

      return peerConnection
    } catch (error) {
      logDebug(`Error creating peer connection for ${userId}:`, error)
      connectionStatusRef.current[userId] = "failed"
    }
  }

  const addStreamToConnection = (peerConnection, stream, targetUserId, sourceUserId) => {
    if (!forwardedTracksRef.current[targetUserId]) {
      forwardedTracksRef.current[targetUserId] = new Set()
    }

    stream.getTracks().forEach((track) => {
      const trackId = `${sourceUserId}_${track.id}`

      if (!forwardedTracksRef.current[targetUserId].has(trackId)) {
        try {
          peerConnection.addTrack(track, stream)
          forwardedTracksRef.current[targetUserId].add(trackId)
          logDebug(`Added forwarded ${track.kind} track from ${sourceUserId} to ${targetUserId}`)
        } catch (error) {
          logDebug(`Error adding forwarded track from ${sourceUserId} to ${targetUserId}:`, error)
        }
      }
    })
  }

  const forwardStreamToAllOthers = (sourceUserId, stream) => {
    if (!call.isGroupCall || !isHubRef.current) return

    logDebug(`Forwarding stream from ${sourceUserId} to all other participants`)

    // Forward to all connected participants (except source and self)
    Object.keys(peerConnectionsRef.current).forEach((targetUserId) => {
      if (targetUserId !== sourceUserId && targetUserId !== user.id) {
        const peerData = peerConnectionsRef.current[targetUserId]
        if (peerData && peerData.connection.connectionState === "connected") {
          addStreamToConnection(peerData.connection, stream, targetUserId, sourceUserId)
        }
      }
    })
  }

  const forwardAllExistingStreamsToParticipant = (targetUserId) => {
    if (!call.isGroupCall || !isHubRef.current) return

    logDebug(`Forwarding all existing streams to ${targetUserId}`)

    const peerData = peerConnectionsRef.current[targetUserId]
    if (!peerData || peerData.connection.connectionState !== "connected") {
      return
    }

    // Forward all stored streams to this participant
    Object.entries(forwardingStreamsRef.current).forEach(([sourceUserId, stream]) => {
      if (sourceUserId !== targetUserId) {
        addStreamToConnection(peerData.connection, stream, targetUserId, sourceUserId)
      }
    })
  }

  const createOffer = async (userId, peerConnection, isRestart = false) => {
    try {
      const peerData = peerConnectionsRef.current[userId]

      if (!peerData) {
        logDebug(`No peer data found for ${userId}`)
        return
      }

      if (peerConnection.signalingState !== "stable") {
        logDebug(`Peer connection not in correct state for offer: ${peerConnection.signalingState}`)
        return
      }

      logDebug(`Creating ${isRestart ? "restart " : ""}offer for ${userId}`)

      const offerOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.callType === "video",
        voiceActivityDetection: true,
        iceRestart: isRestart,
      }

      const offer = await peerConnection.createOffer(offerOptions)
      await peerConnection.setLocalDescription(offer)
      peerData.localDescriptionSet = true
      peerData.offerSent = true

      socket.emit("BE-webrtc-offer", {
        to: userId,
        offer: offer,
        callId: call.callId,
      })

      logDebug(`Offer sent to ${userId}`)
    } catch (error) {
      logDebug(`Error creating offer for ${userId}:`, error)
      connectionStatusRef.current[userId] = "failed"
    }
  }

  const handleOffer = async (userId, offer) => {
    try {
      logDebug(`Handling offer from ${userId}`)

      let peerConnection = peerConnectionsRef.current[userId]?.connection
      let peerData = peerConnectionsRef.current[userId]

      if (!peerConnection) {
        let userInfo = participantsMapRef.current.get(userId)

        if (!userInfo) {
          if (call.isGroupCall) {
            userInfo = connectedUsers.find((u) => u._id === userId || u.id === userId) || { id: userId, name: "User" }
          } else {
            userInfo = call.caller._id === userId || call.caller.id === userId ? call.caller : call.receiver
          }
          participantsMapRef.current.set(userId, userInfo)
        }

        peerConnection = await createPeerConnection(userId, userInfo, false)
        peerData = peerConnectionsRef.current[userId]
      }

      if (!peerConnection || !peerData) {
        logDebug(`Failed to create peer connection for ${userId}`)
        return
      }

      if (peerConnection.signalingState !== "stable") {
        logDebug(`Peer connection not in correct state for remote offer: ${peerConnection.signalingState}`)

        if (peerConnection.signalingState === "have-local-offer") {
          if (call.isGroupCall) {
            if (user.id < userId) {
              logDebug(`Backing down from offer conflict with ${userId}`)
              await peerConnection.setLocalDescription({ type: "rollback" })
              peerData.localDescriptionSet = false
              peerData.offerSent = false
            } else {
              logDebug(`Ignoring offer from ${userId} due to conflict resolution`)
              return
            }
          } else {
            if (call.caller.id !== user.id) {
              logDebug(`Receiver backing down from offer conflict with ${userId}`)
              await peerConnection.setLocalDescription({ type: "rollback" })
              peerData.localDescriptionSet = false
              peerData.offerSent = false
            } else {
              logDebug(`Caller ignoring offer from ${userId}`)
              return
            }
          }
        } else {
          logDebug(`Cannot handle offer in state ${peerConnection.signalingState}, scheduling retry`)
          setTimeout(() => {
            handleOffer(userId, offer)
          }, 1000)
          return
        }
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
      peerData.remoteDescriptionSet = true

      if (iceCandidateBuffersRef.current[userId] && iceCandidateBuffersRef.current[userId].length > 0) {
        logDebug(`Processing ${iceCandidateBuffersRef.current[userId].length} buffered ICE candidates for ${userId}`)

        const candidates = [...iceCandidateBuffersRef.current[userId]]
        iceCandidateBuffersRef.current[userId] = []

        for (const candidate of candidates) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
            logDebug(`Added buffered ICE candidate for ${userId}`)
          } catch (e) {
            logDebug(`Error adding buffered ICE candidate for ${userId}:`, e)
          }
        }
      }

      if (!peerData.answerSent) {
        const answerOptions = {
          offerToReceiveAudio: true,
          offerToReceiveVideo: call.callType === "video",
          voiceActivityDetection: true,
        }

        const answer = await peerConnection.createAnswer(answerOptions)
        await peerConnection.setLocalDescription(answer)
        peerData.localDescriptionSet = true
        peerData.answerSent = true

        socket.emit("BE-webrtc-answer", {
          to: userId,
          answer: answer,
          callId: call.callId,
        })

        logDebug(`Answer sent to ${userId}`)
      }
    } catch (error) {
      logDebug(`Error handling offer from ${userId}:`, error)
      connectionStatusRef.current[userId] = "failed"
    }
  }

  const handleAnswer = async (userId, answer) => {
    try {
      const peerData = peerConnectionsRef.current[userId]

      if (!peerData) {
        logDebug(`No peer data found for ${userId}`)
        return
      }

      const peerConnection = peerData.connection

      if (peerConnection.signalingState !== "have-local-offer") {
        logDebug(`Invalid signaling state for answer: ${peerConnection.signalingState}`)
        return
      }

      logDebug(`Processing answer from ${userId}, signaling state: ${peerConnection.signalingState}`)

      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
      peerData.remoteDescriptionSet = true

      logDebug(`Answer processed successfully for ${userId}`)

      if (iceCandidateBuffersRef.current[userId] && iceCandidateBuffersRef.current[userId].length > 0) {
        logDebug(`Processing ${iceCandidateBuffersRef.current[userId].length} buffered ICE candidates for ${userId}`)

        const candidates = [...iceCandidateBuffersRef.current[userId]]
        iceCandidateBuffersRef.current[userId] = []

        for (const candidate of candidates) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
            logDebug(`Added buffered ICE candidate for ${userId}`)
          } catch (e) {
            logDebug(`Error adding buffered ICE candidate for ${userId}:`, e)
          }
        }
      }
    } catch (error) {
      logDebug(`Error handling answer from ${userId}:`, error)
      connectionStatusRef.current[userId] = "failed"
    }
  }

  const handleIceCandidate = async (userId, candidate) => {
    try {
      const peerData = peerConnectionsRef.current[userId]

      if (!peerData) {
        logDebug(`No peer data found for ${userId}, buffering ICE candidate`)

        if (!iceCandidateBuffersRef.current[userId]) {
          iceCandidateBuffersRef.current[userId] = []
        }
        iceCandidateBuffersRef.current[userId].push(candidate)
        return
      }

      if (peerData.remoteDescriptionSet) {
        await peerData.connection.addIceCandidate(new RTCIceCandidate(candidate))
        logDebug(`Added ICE candidate for ${userId}`)
      } else {
        logDebug(`Remote description not set for ${userId}, buffering ICE candidate`)

        if (!iceCandidateBuffersRef.current[userId]) {
          iceCandidateBuffersRef.current[userId] = []
        }
        iceCandidateBuffersRef.current[userId].push(candidate)
      }
    } catch (error) {
      logDebug(`Error handling ICE candidate from ${userId}:`, error)
    }
  }

  const cleanupPeerConnection = (userId) => {
    if (peerConnectionsRef.current[userId]) {
      try {
        peerConnectionsRef.current[userId].connection.close()
      } catch (error) {
        logDebug(`Error closing peer connection for ${userId}:`, error)
      }
      delete peerConnectionsRef.current[userId]
      delete audioSendersRef.current[userId]
      delete videoSendersRef.current[userId]
      delete iceCandidateBuffersRef.current[userId]
      delete forwardingStreamsRef.current[userId]

      if (forwardedTracksRef.current[userId]) {
        delete forwardedTracksRef.current[userId]
      }

      setRemoteStreams((prev) => {
        const newStreams = { ...prev }
        delete newStreams[userId]
        return newStreams
      })

      setRemoteUserStates((prev) => {
        const newStates = { ...prev }
        delete newStates[userId]
        return newStates
      })

      if (remoteVideosRef.current[userId]) {
        const videoElement = remoteVideosRef.current[userId]
        if (videoElement.srcObject) {
          videoElement.srcObject = null
        }
        delete remoteVideosRef.current[userId]
      }

      connectionStatusRef.current[userId] = "closed"
    }
  }

  const toggleAudio = () => {
    if (!localStreamRef.current) return

    const newAudioState = !isAudioEnabled

    const audioTracks = localStreamRef.current.getAudioTracks()
    audioTracks.forEach((track) => {
      track.enabled = newAudioState
    })

    Object.keys(peerConnectionsRef.current).forEach((userId) => {
      const senders = audioSendersRef.current[userId]
      if (senders) {
        senders.forEach((sender) => {
          if (sender.track) {
            sender.track.enabled = newAudioState
          }
        })
      }

      socket.emit("BE-track-state-changed", {
        to: userId,
        trackType: "audio",
        enabled: newAudioState,
        callId: call.callId,
      })
    })

    setIsAudioEnabled(newAudioState)
  }

  const toggleVideo = () => {
    if (!localStreamRef.current || call.callType !== "video") return

    const newVideoState = !isVideoEnabled
    const videoTracks = localStreamRef.current.getVideoTracks()

    videoTracks.forEach((track) => {
      track.enabled = newVideoState
    })

    Object.keys(peerConnectionsRef.current).forEach((userId) => {
      const senders = videoSendersRef.current[userId]
      if (senders) {
        senders.forEach((sender) => {
          if (sender.track) {
            sender.track.enabled = newVideoState
          }
        })
      }

      socket.emit("BE-track-state-changed", {
        to: userId,
        trackType: "video",
        enabled: newVideoState,
        callId: call.callId,
      })
    })

    setIsVideoEnabled(newVideoState)
  }

  const cleanup = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop()
      })
    }

    Object.keys(peerConnectionsRef.current).forEach((userId) => {
      cleanupPeerConnection(userId)
    })

    Object.values(connectionTimersRef.current).forEach((timeout) => {
      clearTimeout(timeout)
    })

    peerConnectionsRef.current = {}
    audioSendersRef.current = {}
    videoSendersRef.current = {}
    iceCandidateBuffersRef.current = {}
    forwardingStreamsRef.current = {}
    forwardedTracksRef.current = {}
    processedParticipantsRef.current.clear()
    participantsMapRef.current.clear()
    connectionTimersRef.current = {}
    reconnectAttemptsRef.current = {}
    connectionEstablishedRef.current = {}
    connectionStatusRef.current = {}
    localStreamRef.current = null
    isHubRef.current = false
    hubUserIdRef.current = null
  }

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const setupVideoElement = (userId, stream) => {
    const videoElement = remoteVideosRef.current[userId]
    if (!videoElement || !stream) return

    if (videoElement.srcObject === stream) return

    try {
      if (videoElement.srcObject) {
        videoElement.srcObject = null
      }

      videoElement.srcObject = stream
      videoElement.muted = false
      videoElement.volume = 1.0
      videoElement.playsInline = true
      videoElement.autoplay = true

      const playPromise = videoElement.play()
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            logDebug(`Remote video playing for ${userId}`)
          })
          .catch((error) => {
            logDebug(`Play failed for ${userId}, will retry on user interaction:`, error.name)

            const retryPlay = () => {
              videoElement.play().catch(console.error)
              document.removeEventListener("click", retryPlay)
            }
            document.addEventListener("click", retryPlay, { once: true })
          })
      }
    } catch (error) {
      logDebug(`Error setting up video element for ${userId}:`, error)
    }
  }

  const renderRemoteVideos = () => {
    return Object.keys(remoteStreams).map((userId) => {
      const userState = remoteUserStates[userId] || { audio: true, video: true }
      const userInfo = peerConnectionsRef.current[userId]?.userInfo ||
        participantsMapRef.current.get(userId) ||
        connectedUsers.find((u) => u._id === userId || u.id === userId) || { name: "User", id: userId }

      const connectionState = connectionStatusRef.current[userId] || "unknown"

      return (
        <div key={userId} className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
          <video
            ref={(el) => {
              if (el) {
                remoteVideosRef.current[userId] = el
                const stream = remoteStreams[userId]
                if (stream) {
                  setTimeout(() => {
                    setupVideoElement(userId, stream)
                  }, 100)
                }
              }
            }}
            autoPlay
            playsInline
            className={`w-full h-full object-cover ${call.callType === "audio" || !userState.video ? "hidden" : ""}`}
          />

          {(call.callType === "audio" || !userState.video) && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
              <div className="w-16 h-16 bg-blue-500 text-white rounded-full flex items-center justify-center text-xl font-bold">
                {(userInfo.name || "U").charAt(0).toUpperCase()}
              </div>
            </div>
          )}

          <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded flex items-center">
            {userInfo.name || "User"}
            {!userState.audio && <span className="ml-1">(Muted)</span>}
            {call.isGroupCall && userId === hubUserIdRef.current && <span className="ml-1 text-yellow-300">(Hub)</span>}
          </div>

          {!userState.video && call.callType === "video" && (
            <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
          )}

          <div
            className={`absolute top-2 left-2 w-3 h-3 rounded-full ${
              connectionState === "connected" || connectionState === "completed"
                ? "bg-green-500"
                : connectionState === "connecting" || connectionState === "checking"
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-red-500"
            }`}
            title={`Connection: ${connectionState}`}
          ></div>
        </div>
      )
    })
  }

  const actualParticipantCount = Object.keys(remoteStreams).length + 1

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {/* Call header */}
      <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {call.isGroupCall
              ? `Group ${call.callType} call`
              : `${call.callType.charAt(0).toUpperCase() + call.callType.slice(1)} call with ${
                  call.caller.id === user.id ? call.receiver?.name : call.caller.name
                }`}
          </h2>
          <p className="text-sm text-gray-300">
            {formatDuration(callDuration)} • {actualParticipantCount} participant
            {actualParticipantCount !== 1 ? "s" : ""}
            {call.isGroupCall && isHubRef.current && <span className="text-yellow-300 ml-2">• You are the Hub</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-300 flex items-center">
            <Users className="w-4 h-4 mr-1" />
            {actualParticipantCount}
          </span>
          <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Call content */}
      <div className="flex-1 p-2 flex flex-col overflow-hidden">
        {/* Video grid */}
        <div
          ref={containerRef}
          className={`flex-1 grid gap-2 ${gridLayout} overflow-hidden`}
          style={{
            gridAutoRows: "1fr",
            maxHeight: "calc(100vh - 160px)",
          }}
        >
          {/* Remote videos */}
          {renderRemoteVideos()}

          {/* Local video */}
          <div className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${call.callType === "audio" || !isVideoEnabled ? "hidden" : ""}`}
            />

            {(call.callType === "audio" || !isVideoEnabled) && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                <div className="w-16 h-16 bg-blue-500 text-white rounded-full flex items-center justify-center text-xl font-bold">
                  {user.name.charAt(0).toUpperCase()}
                </div>
              </div>
            )}

            <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded">
              You {!isAudioEnabled && "(Muted)"}
              {call.isGroupCall && isHubRef.current && <span className="text-yellow-300 ml-1">(Hub)</span>}
            </div>

            {!isVideoEnabled && call.callType === "video" && (
              <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
            )}
          </div>
        </div>

        {/* Call controls */}
        <div className="mt-4 flex justify-center gap-4">
          <button
            onClick={toggleAudio}
            className={`p-3 rounded-full ${
              isAudioEnabled ? "bg-blue-500 hover:bg-blue-600" : "bg-red-500 hover:bg-red-600"
            } text-white transition-colors`}
            title={isAudioEnabled ? "Mute" : "Unmute"}
          >
            {isAudioEnabled ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
          </button>

          {call.callType === "video" && (
            <button
              onClick={toggleVideo}
              className={`p-3 rounded-full ${
                isVideoEnabled ? "bg-blue-500 hover:bg-blue-600" : "bg-red-500 hover:bg-red-600"
              } text-white transition-colors`}
              title={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
            >
              {isVideoEnabled ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
            </button>
          )}

          <button
            onClick={onEndCall}
            className="p-3 rounded-full bg-red-500 hover:bg-red-600 text-white transition-colors"
            title="End call"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  )
}
