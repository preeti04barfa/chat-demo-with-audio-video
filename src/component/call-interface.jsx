
import { useEffect, useRef, useState, useCallback } from "react"
import { PhoneOff, Mic, MicOff, Video, VideoOff, Users } from "lucide-react"

export function CallInterface({ call, user, socket, onEndCall }) {
  const localVideoRef = useRef(null)
  const remoteVideosRef = useRef({})
  const localStreamRef = useRef(null)
  const peerConnectionsRef = useRef({})
  const audioSendersRef = useRef({})
  const videoSendersRef = useRef({})

  // SFU-specific refs
  const isHubRef = useRef(false)
  const hubUserIdRef = useRef(null)
  const remoteStreamsMapRef = useRef({})
  const iceCandidateBuffersRef = useRef({})
  const connectionStatusRef = useRef({})
  const connectionTimersRef = useRef({})
  const reconnectAttemptsRef = useRef({})
  const processedParticipantsRef = useRef(new Set())
  const participantsMapRef = useRef(new Map())

  // Track which streams have been forwarded to which users
  const forwardedStreamsRef = useRef({}) // {targetUserId: Set<sourceUserId>}

  const [isAudioEnabled, setIsAudioEnabled] = useState(true)
  const [isVideoEnabled, setIsVideoEnabled] = useState(call.callType === "video")
  const [connectedUsers, setConnectedUsers] = useState([])
  const [callDuration, setCallDuration] = useState(0)
  const [remoteStreams, setRemoteStreams] = useState({})
  const [remoteUserStates, setRemoteUserStates] = useState({})
  const [gridLayout, setGridLayout] = useState("grid-cols-1")

  // Logging function
  const logDebug = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
    console.log(`[SFU ${timestamp}] ${message}`, data || "")
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
    } else if (totalParticipants <= 16) {
      setGridLayout("grid-cols-4")
    } else if (totalParticipants <= 25) {
      setGridLayout("grid-cols-5")
    } else {
      setGridLayout("grid-cols-6")
    }
  }, [remoteStreams])

  // Initialize call
  useEffect(() => {
    // Reset all state
    forwardedStreamsRef.current = {}
    remoteStreamsMapRef.current = {}
    iceCandidateBuffersRef.current = {}

    initializeCall()

    const timer = setInterval(() => {
      setCallDuration((prev) => prev + 1)
    }, 1000)

    return () => {
      clearInterval(timer)
      cleanup()
    }
  }, [])

  // Periodic forwarding check for hub - CRITICAL for ensuring all streams are forwarded
  useEffect(() => {
    if (!call.isGroupCall) return

    const interval = setInterval(() => {
      if (isHubRef.current) {
        ensureAllStreamsForwarded()
      }
    }, 2000) // Check every 2 seconds

    return () => clearInterval(interval)
  }, [call.isGroupCall])

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

      if (call.isGroupCall && hubUserIdRef.current === userId) {
        electNewHub()
      }

      if (connectionTimersRef.current[userId]) {
        clearTimeout(connectionTimersRef.current[userId])
        delete connectionTimersRef.current[userId]
      }

      delete reconnectAttemptsRef.current[userId]
      delete connectionStatusRef.current[userId]
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

        setupSFUConnections(participants)
      }
    })

    socket.on("FE-hub-assignment", ({ hubUserId }) => {
      logDebug(`Hub assigned: ${hubUserId}`)
      hubUserIdRef.current = hubUserId
      isHubRef.current = hubUserId === user.id

      if (isHubRef.current) {
        logDebug("I am the hub for this group call")
        // Reset forwarding state
        forwardedStreamsRef.current = {}

        setTimeout(() => {
          connectToAllParticipants()
        }, 1000)
      } else {
        logDebug(`Connecting to hub: ${hubUserId}`)

        // Clean up connections to non-hub users
        Object.keys(peerConnectionsRef.current).forEach((userId) => {
          if (userId !== hubUserId) {
            cleanupPeerConnection(userId)
          }
        })

        const hubUserInfo = participantsMapRef.current.get(hubUserId)
        if (hubUserInfo) {
          createPeerConnection(hubUserId, hubUserInfo, false)
        }
      }
    })

    socket.on("FE-webrtc-offer", async ({ from, offer }) => {
      logDebug(`Received offer from: ${from}`)
      await handleOffer(from, offer)
    })

    socket.on("FE-webrtc-answer", async ({ from, answer }) => {
      logDebug(`Received answer from: ${from}`)
      await handleAnswer(from, answer)
    })

    socket.on("FE-webrtc-ice-candidate", async ({ from, candidate }) => {
      logDebug(`Received ICE candidate from: ${from}`)
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
  }, [socket, call.isGroupCall, user.id])

  const initializeCall = async () => {
    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
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
        remoteStreamsMapRef.current[user.id] = stream

        setTimeout(() => {
          socket.emit("BE-get-call-participants", { callId: call.callId })
        }, 1000)
      } else {
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

      if (isHubRef.current) {
        logDebug(`Hub connecting to new participant ${userId}`)
        setTimeout(() => {
          createPeerConnection(userId, userInfo, true)
        }, 500)
      } else if (userId === hubUserIdRef.current) {
        logDebug(`Connecting to hub ${userId}`)
        setTimeout(() => {
          createPeerConnection(userId, userInfo, false)
        }, 500)
      }
    }
  }

  const setupSFUConnections = (participants) => {
    const sortedParticipants = [...participants].sort((a, b) => {
      if (a.joinedAt && b.joinedAt) {
        return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
      }
      return a.userId.localeCompare(b.userId)
    })

    const hubUserId = sortedParticipants[0]?.userId

    if (hubUserId) {
      hubUserIdRef.current = hubUserId
      isHubRef.current = hubUserId === user.id

      logDebug(`Hub elected: ${hubUserId}, I am hub: ${isHubRef.current}`)

      socket.emit("BE-hub-assignment", {
        callId: call.callId,
        hubUserId: hubUserId,
      })

      setTimeout(() => {
        if (isHubRef.current) {
          connectToAllParticipants()
        } else {
          const hubUserInfo = participantsMapRef.current.get(hubUserId)
          if (hubUserInfo) {
            createPeerConnection(hubUserId, hubUserInfo, false)
          }
        }
      }, 1000)
    }
  }

  const connectToAllParticipants = () => {
    logDebug("Hub connecting to all participants")

    Array.from(processedParticipantsRef.current).forEach((userId) => {
      if (userId !== user.id) {
        const userInfo = participantsMapRef.current.get(userId)
        if (userInfo && !peerConnectionsRef.current[userId]) {
          logDebug(`Hub creating connection to participant: ${userId}`)
          createPeerConnection(userId, userInfo, true)
        }
      }
    })
  }

  const electNewHub = () => {
    const remainingParticipants = Array.from(processedParticipantsRef.current).filter(
      (id) => id !== hubUserIdRef.current && participantsMapRef.current.has(id),
    )

    if (remainingParticipants.length > 0) {
      const newHubUserId = remainingParticipants.sort()[0]
      hubUserIdRef.current = newHubUserId
      isHubRef.current = newHubUserId === user.id

      logDebug(`New hub elected: ${newHubUserId}, I am hub: ${isHubRef.current}`)

      socket.emit("BE-hub-assignment", {
        callId: call.callId,
        hubUserId: newHubUserId,
      })

      setTimeout(() => {
        if (isHubRef.current) {
          forwardedStreamsRef.current = {}
          connectToAllParticipants()
          setTimeout(() => {
            ensureAllStreamsForwarded()
          }, 2000)
        } else {
          Object.keys(peerConnectionsRef.current).forEach((userId) => {
            if (userId !== newHubUserId) {
              cleanupPeerConnection(userId)
            }
          })

          const hubUserInfo = participantsMapRef.current.get(newHubUserId)
          if (hubUserInfo) {
            createPeerConnection(newHubUserId, hubUserInfo, false)
          }
        }
      }, 1000)
    }
  }

  // IMPROVED: Core SFU forwarding function - ensures streams reach all participants
  const forwardStreamToParticipant = (sourceUserId, targetUserId, stream) => {
    if (!isHubRef.current || sourceUserId === targetUserId) return false

    const targetPeer = peerConnectionsRef.current[targetUserId]
    if (!targetPeer || targetPeer.connection.connectionState !== "connected") {
      logDebug(`Target peer ${targetUserId} not ready for forwarding`)
      return false
    }

    // Initialize forwarding tracking for target
    if (!forwardedStreamsRef.current[targetUserId]) {
      forwardedStreamsRef.current[targetUserId] = new Set()
    }

    // Check if already forwarded
    if (forwardedStreamsRef.current[targetUserId].has(sourceUserId)) {
      logDebug(`Stream from ${sourceUserId} already forwarded to ${targetUserId}`)
      return true
    }

    logDebug(`Hub forwarding stream from ${sourceUserId} to ${targetUserId}`)

    try {
      let tracksAdded = 0

      stream.getTracks().forEach((track) => {
        try {
          // Clone the track to avoid conflicts
          const clonedTrack = track.clone()
          
          // Create a new stream for this forwarded track
          const forwardedStream = new MediaStream([clonedTrack])
          
          // Add track to peer connection
          targetPeer.connection.addTrack(clonedTrack, forwardedStream)
          tracksAdded++
          logDebug(`Added ${track.kind} track from ${sourceUserId} to ${targetUserId}`)
        } catch (error) {
          logDebug(`Error adding track from ${sourceUserId} to ${targetUserId}:`, error)
        }
      })

      if (tracksAdded > 0) {
        forwardedStreamsRef.current[targetUserId].add(sourceUserId)
        logDebug(`Successfully forwarded ${tracksAdded} tracks from ${sourceUserId} to ${targetUserId}`)
        return true
      }
    } catch (error) {
      logDebug(`Error forwarding stream from ${sourceUserId} to ${targetUserId}:`, error)
    }

    return false
  }

  // IMPROVED: Critical function to ensure all streams are forwarded to all participants
  const ensureAllStreamsForwarded = () => {
    if (!isHubRef.current) return

    logDebug("Hub ensuring all streams are forwarded to all participants")

    // Get all connected participants (excluding hub itself)
    const allParticipants = Object.keys(peerConnectionsRef.current).filter(id => id !== user.id)

    // Get all available streams (including hub's own stream)
    const allStreams = { ...remoteStreamsMapRef.current }
    if (localStreamRef.current) {
      allStreams[user.id] = localStreamRef.current
    }

    logDebug(`Hub has ${Object.keys(allStreams).length} streams to forward to ${allParticipants.length} participants`)

    // For each participant, ensure they receive ALL streams
    allParticipants.forEach((targetUserId) => {
      logDebug(`Ensuring participant ${targetUserId} receives all streams`)
      
      // For each stream, ensure it's forwarded to this participant
      Object.entries(allStreams).forEach(([sourceUserId, stream]) => {
        if (sourceUserId !== targetUserId && stream) {
          const success = forwardStreamToParticipant(sourceUserId, targetUserId, stream)
          if (success) {
            logDebug(`✓ Stream from ${sourceUserId} forwarded to ${targetUserId}`)
          } else {
            logDebug(`✗ Failed to forward stream from ${sourceUserId} to ${targetUserId}`)
          }
        }
      })
    })

    // Log current forwarding status
    logDebug("Current forwarding status:", {
      totalStreams: Object.keys(allStreams).length,
      totalParticipants: allParticipants.length,
      forwardingMap: Object.fromEntries(
        Object.entries(forwardedStreamsRef.current).map(([key, value]) => [key, Array.from(value)])
      )
    })
  }

  const createPeerConnection = async (userId, userInfo, shouldInitiateOffer = null) => {
    try {
      if (peerConnectionsRef.current[userId]) {
        const existingConnection = peerConnectionsRef.current[userId].connection
        if (existingConnection.connectionState === "connected" || existingConnection.connectionState === "connecting") {
          logDebug(`Peer connection for user ${userId} already exists`)
          return existingConnection
        }
        cleanupPeerConnection(userId)
      }

      logDebug(`Creating peer connection for user ${userId}`)

      connectionStatusRef.current[userId] = "connecting"

      const configuration = {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: "turn:numb.viagenie.ca",
            credential: "muazkh",
            username: "webrtc@live.com",
          },
        ],
        iceCandidatePoolSize: 10,
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
      }

      // Add local stream tracks
      if (localStreamRef.current) {
        audioSendersRef.current[userId] = []
        videoSendersRef.current[userId] = []

        localStreamRef.current.getTracks().forEach((track) => {
          const sender = peerConnection.addTrack(track, localStreamRef.current)
          if (track.kind === "audio") {
            audioSendersRef.current[userId].push(sender)
          } else {
            videoSendersRef.current[userId].push(sender)
          }
        })
      }

      // IMPROVED: Handle incoming tracks - crucial for participants to receive forwarded streams
      peerConnection.ontrack = (event) => {
        logDebug(`Received track from ${userId}`, event)
        const [remoteStream] = event.streams

        if (remoteStream) {
          logDebug(`Setting up remote stream for ${userId}`)

          // Store the stream
          remoteStreamsMapRef.current[userId] = remoteStream

          setRemoteStreams((prev) => {
            logDebug(`Adding remote stream for ${userId} to state`)
            return {
              ...prev,
              [userId]: remoteStream,
            }
          })

          setRemoteUserStates((prev) => ({
            ...prev,
            [userId]: {
              audio: true,
              video: call.callType === "video",
            },
          }))

          // If this is the hub receiving a stream, forward it to ALL other participants
          if (call.isGroupCall && isHubRef.current) {
            logDebug(`Hub received stream from ${userId}, forwarding to all other participants`)

            // Immediately forward this stream to all other connected participants
            setTimeout(() => {
              Object.keys(peerConnectionsRef.current).forEach((targetUserId) => {
                if (targetUserId !== userId && targetUserId !== user.id) {
                  forwardStreamToParticipant(userId, targetUserId, remoteStream)
                }
              })

              // Also ensure all existing streams are forwarded to this new participant
              if (localStreamRef.current) {
                forwardStreamToParticipant(user.id, userId, localStreamRef.current)
              }

              Object.entries(remoteStreamsMapRef.current).forEach(([sourceUserId, sourceStream]) => {
                if (sourceUserId !== userId && sourceUserId !== user.id && sourceStream) {
                  forwardStreamToParticipant(sourceUserId, userId, sourceStream)
                }
              })
            }, 500)
          }

          connectionStatusRef.current[userId] = "connected"
        }
      }

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("BE-webrtc-ice-candidate", {
            to: userId,
            candidate: event.candidate,
            callId: call.callId,
          })
        }
      }

      peerConnection.oniceconnectionstatechange = () => {
        logDebug(`ICE connection state for ${userId}: ${peerConnection.iceConnectionState}`)
        connectionStatusRef.current[userId] = peerConnection.iceConnectionState

        if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
          reconnectAttemptsRef.current[userId] = 0

          // Process buffered ICE candidates
          if (iceCandidateBuffersRef.current[userId]?.length > 0) {
            const candidates = [...iceCandidateBuffersRef.current[userId]]
            iceCandidateBuffersRef.current[userId] = []

            candidates.forEach(async (candidate) => {
              try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
              } catch (e) {
                logDebug(`Error adding buffered ICE candidate:`, e)
              }
            })
          }

          // CRITICAL: If hub, ensure ALL streams are forwarded after connection is established
          if (call.isGroupCall && isHubRef.current) {
            setTimeout(() => {
              logDebug(`Connection established with ${userId}, ensuring all streams forwarded`)
              ensureAllStreamsForwarded()
            }, 1000)
          }
        }

        if (peerConnection.iceConnectionState === "failed" || peerConnection.iceConnectionState === "disconnected") {
          if (!connectionTimersRef.current[userId]) {
            connectionTimersRef.current[userId] = setTimeout(() => {
              delete connectionTimersRef.current[userId]
              const attempts = reconnectAttemptsRef.current[userId] || 0
              if (attempts < 3) {
                reconnectAttemptsRef.current[userId] = attempts + 1
                cleanupPeerConnection(userId)
                const userInfo = participantsMapRef.current.get(userId)
                if (userInfo) {
                  setTimeout(() => {
                    createPeerConnection(userId, userInfo, isHubRef.current)
                  }, 1000)
                }
              }
            }, 3000)
          }
        }
      }

      // Determine who should initiate the offer
      if (call.isGroupCall) {
        shouldInitiateOffer = isHubRef.current
      } else {
        shouldInitiateOffer = call.caller.id === user.id
      }

      if (shouldInitiateOffer) {
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

  // ... keep existing code (createOffer, handleOffer, handleAnswer, handleIceCandidate, cleanupPeerConnection, toggleAudio, toggleVideo, cleanup, formatDuration, setupVideoElement functions)

  const createOffer = async (userId, peerConnection) => {
    try {
      const peerData = peerConnectionsRef.current[userId]
      if (!peerData || peerConnection.signalingState !== "stable") return

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.callType === "video",
      })

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
    }
  }

  const handleOffer = async (userId, offer) => {
    try {
      let peerConnection = peerConnectionsRef.current[userId]?.connection
      let peerData = peerConnectionsRef.current[userId]

      if (!peerConnection) {
        let userInfo = participantsMapRef.current.get(userId)
        if (!userInfo) {
          userInfo = connectedUsers.find((u) => u._id === userId || u.id === userId) || { id: userId, name: "User" }
          participantsMapRef.current.set(userId, userInfo)
        }
        peerConnection = await createPeerConnection(userId, userInfo, false)
        peerData = peerConnectionsRef.current[userId]
      }

      if (!peerConnection || !peerData) return

      if (peerConnection.signalingState !== "stable") {
        if (peerConnection.signalingState === "have-local-offer") {
          if (user.id < userId) {
            await peerConnection.setLocalDescription({ type: "rollback" })
            peerData.localDescriptionSet = false
            peerData.offerSent = false
          } else {
            return
          }
        } else {
          setTimeout(() => handleOffer(userId, offer), 1000)
          return
        }
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
      peerData.remoteDescriptionSet = true

      // Process buffered ICE candidates
      if (iceCandidateBuffersRef.current[userId]?.length > 0) {
        const candidates = [...iceCandidateBuffersRef.current[userId]]
        iceCandidateBuffersRef.current[userId] = []

        for (const candidate of candidates) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (e) {
            logDebug(`Error adding buffered ICE candidate:`, e)
          }
        }
      }

      if (!peerData.answerSent) {
        const answer = await peerConnection.createAnswer()
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
    }
  }

  const handleAnswer = async (userId, answer) => {
    try {
      const peerData = peerConnectionsRef.current[userId]
      if (!peerData || peerData.connection.signalingState !== "have-local-offer") return

      await peerData.connection.setRemoteDescription(new RTCSessionDescription(answer))
      peerData.remoteDescriptionSet = true

      // Process buffered ICE candidates
      if (iceCandidateBuffersRef.current[userId]?.length > 0) {
        const candidates = [...iceCandidateBuffersRef.current[userId]]
        iceCandidateBuffersRef.current[userId] = []

        for (const candidate of candidates) {
          try {
            await peerData.connection.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (e) {
            logDebug(`Error adding buffered ICE candidate:`, e)
          }
        }
      }
    } catch (error) {
      logDebug(`Error handling answer from ${userId}:`, error)
    }
  }

  const handleIceCandidate = async (userId, candidate) => {
    try {
      const peerData = peerConnectionsRef.current[userId]

      if (!peerData) {
        if (!iceCandidateBuffersRef.current[userId]) {
          iceCandidateBuffersRef.current[userId] = []
        }
        iceCandidateBuffersRef.current[userId].push(candidate)
        return
      }

      if (peerData.remoteDescriptionSet) {
        await peerData.connection.addIceCandidate(new RTCIceCandidate(candidate))
      } else {
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
      delete remoteStreamsMapRef.current[userId]

      // Clean up forwarding references
      if (forwardedStreamsRef.current[userId]) {
        delete forwardedStreamsRef.current[userId]
      }

      Object.keys(forwardedStreamsRef.current).forEach((targetUserId) => {
        if (forwardedStreamsRef.current[targetUserId]) {
          forwardedStreamsRef.current[targetUserId].delete(userId)
        }
      })

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
          videoElement.srcObject.getTracks().forEach((track) => track.stop())
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

    localStreamRef.current.getAudioTracks().forEach((track) => {
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
    localStreamRef.current.getVideoTracks().forEach((track) => {
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

    // Reset all refs
    peerConnectionsRef.current = {}
    audioSendersRef.current = {}
    videoSendersRef.current = {}
    iceCandidateBuffersRef.current = {}
    remoteStreamsMapRef.current = {}
    forwardedStreamsRef.current = {}
    processedParticipantsRef.current.clear()
    participantsMapRef.current.clear()
    connectionTimersRef.current = {}
    reconnectAttemptsRef.current = {}
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
        videoElement.srcObject.getTracks().forEach((track) => track.stop())
        videoElement.srcObject = null
      }

      videoElement.srcObject = stream
      videoElement.muted = false
      videoElement.volume = 1.0
      videoElement.playsInline = true
      videoElement.autoplay = true

      const playPromise = videoElement.play()
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
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

  const renderAllVideos = () => {
    const allStreams = []

    // Add local stream
    allStreams.push({
      userId: user.id,
      stream: localStreamRef.current,
      userInfo: user,
      isLocal: true,
      userState: { audio: isAudioEnabled, video: isVideoEnabled },
    })

    // Add all remote streams
    Object.keys(remoteStreams).forEach((userId) => {
      if (userId !== user.id) {
        allStreams.push({
          userId,
          stream: remoteStreams[userId],
          userInfo: peerConnectionsRef.current[userId]?.userInfo ||
            participantsMapRef.current.get(userId) ||
            connectedUsers.find((u) => u._id === userId || u.id === userId) || { name: "User", id: userId },
          isLocal: false,
          userState: remoteUserStates[userId] || { audio: true, video: call.callType === "video" },
        })
      }
    })

    return allStreams.map(({ userId, stream, userInfo, isLocal, userState }) => {
      const connectionState = isLocal ? "connected" : connectionStatusRef.current[userId] || "unknown"

      return (
        <div key={userId} className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
          <video
            ref={(el) => {
              if (el) {
                if (isLocal) {
                  if (localVideoRef.current !== el) {
                    localVideoRef.current = el
                    if (stream) {
                      el.srcObject = stream
                      el.muted = true
                      el.playsInline = true
                      el.autoplay = true
                    }
                  }
                } else {
                  remoteVideosRef.current[userId] = el
                  if (stream) {
                    setTimeout(() => {
                      setupVideoElement(userId, stream)
                    }, 100)
                  }
                }
              }
            }}
            autoPlay
            playsInline
            muted={isLocal}
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
            {isLocal ? "You" : userInfo.name || "User"}
            {!userState.audio && <span className="ml-1">(Muted)</span>}
            {call.isGroupCall && userId === hubUserIdRef.current && <span className="ml-1 text-yellow-300">(Hub)</span>}
            {isLocal && <span className="ml-1 text-green-300">(You)</span>}
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
      <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {call.isGroupCall
              ? `Group ${call.callType} call (SFU)`
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

      <div className="flex-1 p-2 flex flex-col overflow-hidden">
        <div
          className={`flex-1 grid gap-2 ${gridLayout} overflow-hidden`}
          style={{
            gridAutoRows: "1fr",
            maxHeight: "calc(100vh - 160px)",
          }}
        >
          {renderAllVideos()}
        </div>

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

      {/* Debug panel - shows current state */}
      <div className="bg-gray-700 p-2 text-xs text-gray-300">
        <div>
          Hub: {hubUserIdRef.current} | Am Hub: {isHubRef.current ? "Yes" : "No"} | Connections: {Object.keys(peerConnectionsRef.current).length} | Remote Streams: {Object.keys(remoteStreams).length}
        </div>
        <div>
          SFU Model: Each participant → Hub → All participants (Complete Grid) | Forwarded: {JSON.stringify(Object.fromEntries(Object.entries(forwardedStreamsRef.current).map(([key, value]) => [key, Array.from(value || [])])))}
        </div>
      </div>
    </div>
  )
}