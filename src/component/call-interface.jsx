import { useEffect, useRef, useState, useCallback } from "react"
import { PhoneOff, Mic, MicOff, Video, VideoOff, Users, RefreshCw, AlertCircle } from "lucide-react"

export function CallInterface({ call, user, socket, onEndCall }) {

  const localVideoRef = useRef(null)
  const remoteVideosRef = useRef({})
  const localStreamRef = useRef(null)
  const peerConnectionsRef = useRef({})
  const audioSendersRef = useRef({})
  const videoSendersRef = useRef({})
  const containerRef = useRef(null)
  const audioContextRef = useRef(null)
  const audioDestinationRef = useRef(null)
  const audioSourcesRef = useRef({})

  const connectionStatusRef = useRef({})
  const connectionTimersRef = useRef({})
  const reconnectAttemptsRef = useRef({})
  const pendingConnectionsRef = useRef(new Set())
  const processedParticipantsRef = useRef(new Set())
  const participantsMapRef = useRef(new Map())
  const iceCandidateBuffersRef = useRef({})
  const connectionEstablishedRef = useRef({})
  const lastConnectionAttemptRef = useRef({})
  const connectionCheckIntervalRef = useRef(null)


  const [isAudioEnabled, setIsAudioEnabled] = useState(true)
  const [isVideoEnabled, setIsVideoEnabled] = useState(call.callType === "video")
  const [connectedUsers, setConnectedUsers] = useState([])
  const [callDuration, setCallDuration] = useState(0)
  const [remoteStreams, setRemoteStreams] = useState({})
  const [remoteUserStates, setRemoteUserStates] = useState({})
  const [gridLayout, setGridLayout] = useState("grid-cols-1")
  const [audioLevels, setAudioLevels] = useState({})
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [connectionStats, setConnectionStats] = useState({
    expected: 0,
    connected: 0,
    audioConnected: 0,
    videoConnected: 0,
    failed: 0,
  })
  const [showDebugInfo, setShowDebugInfo] = useState(false)
  const [debugMessages, setDebugMessages] = useState([])


  const logDebug = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage, data || "")

    setDebugMessages((prev) => {
      const newMessages = [...prev, { time: timestamp, message, data: JSON.stringify(data || "") }]
      return newMessages.slice(-50) 
    })
  }, [])

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

  //better audio handling
  useEffect(() => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      audioContextRef.current = new AudioContext()
      audioDestinationRef.current = audioContextRef.current.createMediaStreamDestination()

      return () => {
        if (audioContextRef.current && audioContextRef.current.state !== "closed") {
          audioContextRef.current.close()
        }
      }
    } catch (error) {
      logDebug("Error initializing audio context:", error)
    }
  }, [])

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
        if (!processedParticipantsRef.current.has(userId) || connectionStatusRef.current[userId] === "failed") {
          processedParticipantsRef.current.add(userId)
          const delay = Math.random() * 1000 + 500
          logDebug(`Scheduling connection to ${userId} in ${delay}ms`)

          setTimeout(() => {
            if (!connectionEstablishedRef.current[userId]) {
              createPeerConnection(userId, userInfo, true)
            }
          }, delay)
        }
      } else {
        // One-to-one call
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

      if (connectionTimersRef.current[userId]) {
        clearTimeout(connectionTimersRef.current[userId])
        delete connectionTimersRef.current[userId]
      }

      delete reconnectAttemptsRef.current[userId]
      delete connectionStatusRef.current[userId]
      delete lastConnectionAttemptRef.current[userId]
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
          // Filter out duplicates
          const existingIds = new Set(newConnectedUsers.map((u) => u.id || u._id))
          const filteredPrev = prev.filter((u) => !existingIds.has(u.id || u._id))
          return [...filteredPrev, ...newConnectedUsers]
        })

        participants.forEach((participant, index) => {
          if (participant.userId !== user.id) {
            setTimeout(
              () => {
                if (!connectionEstablishedRef.current[participant.userId]) {
                  createPeerConnection(participant.userId, participant.userInfo, true)
                }
              },
              1000 + index * 500,
            )
          }
        })

        setConnectionStats((prev) => ({
          ...prev,
          expected: participants.length,
        }))
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
      socket.off("FE-webrtc-offer")
      socket.off("FE-webrtc-answer")
      socket.off("FE-webrtc-ice-candidate")
      socket.off("FE-track-state-changed")
    }
  }, [socket, call.isGroupCall, user.id, logDebug])

  useEffect(() => {
    if (!call.isGroupCall) return

    connectionCheckIntervalRef.current = setInterval(() => {
      const now = Date.now()
      let connectedCount = 0
      let audioConnectedCount = 0
      let videoConnectedCount = 0
      let failedCount = 0

      processedParticipantsRef.current.forEach((userId) => {
        if (userId === user.id) return 

        const peerData = peerConnectionsRef.current[userId]
        const connectionStatus = connectionStatusRef.current[userId]

        if (peerData && ["connected", "completed"].includes(peerData.connection.iceConnectionState)) {
          connectedCount++
          if (peerData.audioConnected) audioConnectedCount++
          if (peerData.videoConnected) videoConnectedCount++
        }
        else if (connectionStatus === "failed" || (!peerData && participantsMapRef.current.has(userId))) {
          failedCount++

          const lastAttempt = lastConnectionAttemptRef.current[userId] || 0
          const attempts = reconnectAttemptsRef.current[userId] || 0

          // If it's been more than 10 seconds since last attempt and we've tried less than 5 times
          if (now - lastAttempt > 10000 && attempts < 5 && !pendingConnectionsRef.current.has(userId)) {
            logDebug(`Auto-reconnecting to ${userId}, attempt ${attempts + 1}/5`)

            cleanupPeerConnection(userId)

            pendingConnectionsRef.current.add(userId)

            reconnectAttemptsRef.current[userId] = attempts + 1
            lastConnectionAttemptRef.current[userId] = now

            const userInfo = participantsMapRef.current.get(userId)

            setTimeout(() => {
              pendingConnectionsRef.current.delete(userId)
              if (userInfo) {
                createPeerConnection(userId, userInfo, true)
              }
            }, 1000)
          }
        }
      })

      setConnectionStats({
        expected: processedParticipantsRef.current.size - 1, 
        connected: connectedCount,
        audioConnected: audioConnectedCount,
        videoConnected: videoConnectedCount,
        failed: failedCount,
      })

      logDebug(
        `Connection status: ${connectedCount}/${processedParticipantsRef.current.size - 1} connected, ${failedCount} failed`,
      )
    }, 5000)

    return () => {
      if (connectionCheckIntervalRef.current) {
        clearInterval(connectionCheckIntervalRef.current)
      }
    }
  }, [call.isGroupCall, user.id, logDebug])

  useEffect(() => {
    const audioLevelInterval = setInterval(() => {
      Object.keys(remoteStreams).forEach((userId) => {
        const stream = remoteStreams[userId]
        if (stream && stream.getAudioTracks().length > 0) {
          const audioTrack = stream.getAudioTracks()[0]

          if (audioTrack && audioTrack.enabled && audioTrack.readyState === "live") {
            setAudioLevels((prev) => ({
              ...prev,
              [userId]: true,
            }))
          } else {
            logDebug(`Audio track for ${userId} is not active or enabled`)
            setAudioLevels((prev) => ({
              ...prev,
              [userId]: false,
            }))
          }
        }
      })
    }, 3000)

    return () => clearInterval(audioLevelInterval)
  }, [remoteStreams, logDebug])

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
        // one-to-one calls
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

      //audio processing
      if (audioSourcesRef.current[userId]) {
        try {
          if (audioSourcesRef.current[userId].source) {
            audioSourcesRef.current[userId].source.disconnect()
          }
          if (audioSourcesRef.current[userId].filter) {
            audioSourcesRef.current[userId].filter.disconnect()
          }
          if (audioSourcesRef.current[userId].gain) {
            audioSourcesRef.current[userId].gain.disconnect()
          }
        } catch (e) {
          logDebug(`Error disconnecting audio source for ${userId}:`, e)
        }
        delete audioSourcesRef.current[userId]
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

      setAudioLevels((prev) => {
        const newLevels = { ...prev }
        delete newLevels[userId]
        return newLevels
      })

      // Clean up video
      if (remoteVideosRef.current[userId]) {
        const videoElement = remoteVideosRef.current[userId]
        if (videoElement.srcObject) {
          videoElement.srcObject = null
        }
        delete remoteVideosRef.current[userId]
      }

      // Update connection status
      connectionStatusRef.current[userId] = "closed"
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
      lastConnectionAttemptRef.current[userId] = Date.now()

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

      // Initialize ICE candidate buffer
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
        audioConnected: false,
        videoConnected: false,
        connectionAttempts: reconnectAttemptsRef.current[userId] || 0,
      }

      // Add local stream tracks with audio handling
      if (localStreamRef.current) {
        audioSendersRef.current[userId] = []
        videoSendersRef.current[userId] = []

        localStreamRef.current.getTracks().forEach((track) => {
          logDebug(`Adding ${track.kind} track to peer connection for ${userId}`)

          // audio tracks in group calls
          if (track.kind === "audio" && call.isGroupCall) {
            const clonedTrack = track.clone()
            clonedTrack.enabled = isAudioEnabled

            const sender = peerConnection.addTrack(clonedTrack, localStreamRef.current)
            audioSendersRef.current[userId] = [sender]

            logDebug(`Added cloned audio track to peer connection for ${userId}`)
          } else {
            const sender = peerConnection.addTrack(track, localStreamRef.current)

            if (track.kind === "audio") {
              audioSendersRef.current[userId].push(sender)
            } else {
              videoSendersRef.current[userId].push(sender)
            }
          }
        })
      }

      // Handle incoming tracks with  audio processing
      peerConnection.ontrack = (event) => {
        logDebug(`Received ${event.track.kind} track from ${userId}`)
        const [remoteStream] = event.streams

        if (remoteStream) {
          logDebug(`Setting remote stream for ${userId}`)

          //audio tracks
          if (event.track.kind === "audio") {
            peerConnectionsRef.current[userId].audioConnected = true

            // audio track details
            logDebug(`Audio track from ${userId}:`, {
              enabled: event.track.enabled,
              readyState: event.track.readyState,
              muted: event.track.muted,
              id: event.track.id,
            })

            // Force unmute the track
            event.track.enabled = true

            // Connect to audio context for if available
            if (audioContextRef.current && audioContextRef.current.state !== "closed") {
              try {
                // Create a gain node to reduce background noise
                const audioSource = audioContextRef.current.createMediaStreamSource(new MediaStream([event.track]))
                const gainNode = audioContextRef.current.createGain()
                gainNode.gain.value = 0.8 // Slightly reduce volume to minimize background noise

                // Add a filter to reduce background noise
                const filter = audioContextRef.current.createBiquadFilter()
                filter.type = "lowpass"
                filter.frequency.value = 8000 // Cut high frequencies

                // Connect the audio processing chain
                audioSource.connect(filter)
                filter.connect(gainNode)
                gainNode.connect(audioContextRef.current.destination)

                audioSourcesRef.current[userId] = {
                  source: audioSource,
                  filter: filter,
                  gain: gainNode,
                }

                logDebug(`Connected audio track from ${userId} to audio context with noise reduction`)
              } catch (e) {
                logDebug("Error connecting to audio context:", e)
              }
            }
          }

          if (event.track.kind === "video") {
            peerConnectionsRef.current[userId].videoConnected = true
          }

          setRemoteStreams((prev) => ({
            ...prev,
            [userId]: remoteStream,
          }))

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

      // ICE candidate
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          logDebug(`Generated ICE candidate for ${userId}`, event.candidate)

          // Send ICE candidate to remote peer
          socket.emit("BE-webrtc-ice-candidate", {
            to: userId,
            candidate: event.candidate,
            callId: call.callId,
          })
        }
      }

      // Enhanced connection state monitoring
      peerConnection.oniceconnectionstatechange = () => {
        logDebug(`ICE connection state for ${userId}: ${peerConnection.iceConnectionState}`)

        if (peerConnectionsRef.current[userId]) {
          peerConnectionsRef.current[userId].connectionState = peerConnection.iceConnectionState
        }

        // Update connection status
        connectionStatusRef.current[userId] = peerConnection.iceConnectionState

        if (peerConnection.iceConnectionState === "failed" || peerConnection.iceConnectionState === "disconnected") {
          logDebug(`Connection to ${userId} ${peerConnection.iceConnectionState}, scheduling restart`)

          // Schedule restart
          if (!connectionTimersRef.current[userId]) {
            connectionTimersRef.current[userId] = setTimeout(() => {
              delete connectionTimersRef.current[userId]

              // Only restart if still failed/disconnected
              if (
                peerConnection.iceConnectionState === "failed" ||
                peerConnection.iceConnectionState === "disconnected"
              ) {
                // Try ICE restart first
                try {
                  peerConnection.restartIce()
                  logDebug(`ICE restart initiated for ${userId}`)

                  // If that doesn't work, try renegotiation
                  setTimeout(() => {
                    if (
                      peerConnection.iceConnectionState === "failed" ||
                      peerConnection.iceConnectionState === "disconnected"
                    ) {
                      createOffer(userId, peerConnection, true)
                    }
                  }, 2000)
                } catch (e) {
                  logDebug(`Error during ICE restart for ${userId}:`, e)

                  // If ICE restart fails, recreate the connection
                  const attempts = reconnectAttemptsRef.current[userId] || 0
                  if (attempts < 5) {
                    reconnectAttemptsRef.current[userId] = attempts + 1
                    logDebug(`Recreating connection to ${userId}, attempt ${attempts + 1}/5`)

                    // Clean up and recreate
                    cleanupPeerConnection(userId)

                    // Get user info
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
                }
              }
            }, 3000)
          }
        }

        // If connected, clear reconnection attempts
        if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
          reconnectAttemptsRef.current[userId] = 0
          connectionEstablishedRef.current[userId] = true

          // Process any buffered ICE candidates
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
      }

      peerConnection.onconnectionstatechange = () => {
        logDebug(`Connection state for ${userId}: ${peerConnection.connectionState}`)

        if (peerConnectionsRef.current[userId]) {
          peerConnectionsRef.current[userId].connectionState = peerConnection.connectionState
        }

        // If connection failed, try to reconnect
        if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
          connectionStatusRef.current[userId] = "failed"

          // Schedule reconnection if not already scheduled
          if (!connectionTimersRef.current[userId]) {
            const attempts = reconnectAttemptsRef.current[userId] || 0
            if (attempts < 5) {
              reconnectAttemptsRef.current[userId] = attempts + 1

              connectionTimersRef.current[userId] = setTimeout(() => {
                delete connectionTimersRef.current[userId]
                logDebug(`Attempting to reconnect to ${userId}, attempt ${attempts + 1}/5`)

                // Clean up and recreate
                cleanupPeerConnection(userId)

                // Get user info
                const userInfo = participantsMapRef.current.get(userId)
                if (userInfo) {
                  createPeerConnection(userId, userInfo, true)
                }
              }, 2000)
            } else {
              logDebug(`Max reconnection attempts reached for ${userId}`)
            }
          }
        }

        // If connected, clear reconnection attempts
        if (peerConnection.connectionState === "connected") {
          reconnectAttemptsRef.current[userId] = 0
          connectionEstablishedRef.current[userId] = true
          connectionStatusRef.current[userId] = "connected"
        }
      }

      peerConnection.onsignalingstatechange = () => {
        logDebug(`Signaling state for ${userId}: ${peerConnection.signalingState}`)
      }

      // Always initiate offer in group calls to ensure full mesh
      if (call.isGroupCall) {
        shouldInitiateOffer = true
      } else {
        // In one-to-one calls, caller creates offer
        shouldInitiateOffer = call.caller.id === user.id
      }

      // Create offer with a slight delay
      if (shouldInitiateOffer) {
        peerConnectionsRef.current[userId].offerSent = true
        setTimeout(
          () => {
            if (peerConnection.signalingState === "stable") {
              createOffer(userId, peerConnection)
            }
          },
          500 + Math.random() * 1000,
        ) // Random delay to avoid conflicts
      }

      return peerConnection
    } catch (error) {
      logDebug(`Error creating peer connection for ${userId}:`, error)
      connectionStatusRef.current[userId] = "failed"
    }
  }

  const createOffer = async (userId, peerConnection, isRestart = false) => {
    try {
      const peerData = peerConnectionsRef.current[userId]

      if (!peerData) {
        logDebug(`No peer data found for ${userId}`)
        return
      }

      // Check if peer connection is in correct state
      if (peerConnection.signalingState !== "stable") {
        logDebug(`Peer connection not in correct state for offer: ${peerConnection.signalingState}`)
        return
      }

      logDebug(`Creating ${isRestart ? "restart " : ""}offer for ${userId}`)

      // Enhanced SDP options for better audio
      const offerOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.callType === "video",
        voiceActivityDetection: true,
        iceRestart: isRestart, // Use ICE restart if needed
      }

      const offer = await peerConnection.createOffer(offerOptions)

      // Modify SDP to prioritize audio and reduce noise
      offer.sdp = enhanceAudioSdp(offer.sdp)

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

  // Helper function to enhance audio SDP
  const enhanceAudioSdp = (sdp) => {
    // Increase audio priority and quality, reduce noise
    const modifiedSdp = sdp
      .replace(/(a=mid:0\r\n)/g, "$1a=content:main\r\n")
      .replace(/(a=mid:audio\r\n)/g, "$1a=content:main\r\n")
      // Enhanced audio settings for better quality and noise reduction
      .replace(/(useinbandfec=1)/g, "useinbandfec=1;stereo=1;maxaveragebitrate=510000")
      // Add noise suppression
      .replace(
        /(a=rtpmap:111 opus\/48000\/2\r\n)/g,
        "$1a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;cbr=1\r\n",
      )

    return modifiedSdp
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

          // Add to participants map
          participantsMapRef.current.set(userId, userInfo)
        }

        peerConnection = await createPeerConnection(userId, userInfo, false) // Don't initiate offer since we're receiving one
        peerData = peerConnectionsRef.current[userId]
      }

      if (!peerConnection || !peerData) {
        logDebug(`Failed to create peer connection for ${userId}`)
        return
      }

      // Check signaling state before setting remote description
      if (peerConnection.signalingState !== "stable") {
        logDebug(`Peer connection not in correct state for remote offer: ${peerConnection.signalingState}`)

        // Handle glare condition (both sides sending offers)
        if (peerConnection.signalingState === "have-local-offer") {
          if (call.isGroupCall) {
            // In group calls, use user ID to resolve conflicts
            if (user.id < userId) {
              // Lower ID backs down
              logDebug(`Backing down from offer conflict with ${userId}`)
              await peerConnection.setLocalDescription({ type: "rollback" })
              peerData.localDescriptionSet = false
              peerData.offerSent = false
            } else {
              // Higher ID ignores this offer
              logDebug(`Ignoring offer from ${userId} due to conflict resolution`)
              return
            }
          } else {
            // In one-to-one calls, receiver backs down
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

          // Schedule retry
          setTimeout(() => {
            handleOffer(userId, offer)
          }, 1000)
          return
        }
      }

      // Enhance audio in SDP
      offer.sdp = enhanceAudioSdp(offer.sdp)

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
      peerData.remoteDescriptionSet = true

      // Process any buffered ICE candidates
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

      // Create answer if not already sent
      if (!peerData.answerSent) {
        // Enhanced answer options for better audio
        const answerOptions = {
          offerToReceiveAudio: true,
          offerToReceiveVideo: call.callType === "video",
          voiceActivityDetection: true,
        }

        const answer = await peerConnection.createAnswer(answerOptions)

        // Enhance audio in SDP
        answer.sdp = enhanceAudioSdp(answer.sdp)

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

      // Check signaling state before setting remote description
      if (peerConnection.signalingState !== "have-local-offer") {
        logDebug(`Invalid signaling state for answer: ${peerConnection.signalingState}`)
        return
      }

      logDebug(`Processing answer from ${userId}, signaling state: ${peerConnection.signalingState}`)

      // Enhance audio in SDP
      answer.sdp = enhanceAudioSdp(answer.sdp)

      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
      peerData.remoteDescriptionSet = true

      logDebug(`Answer processed successfully for ${userId}`)

      // Process any buffered ICE candidates
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

        // Buffer the candidate for later
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

        // Buffer the candidate for later
        if (!iceCandidateBuffersRef.current[userId]) {
          iceCandidateBuffersRef.current[userId] = []
        }
        iceCandidateBuffersRef.current[userId].push(candidate)
      }
    } catch (error) {
      logDebug(`Error handling ICE candidate from ${userId}:`, error)
    }
  }

  const toggleAudio = () => {
    if (!localStreamRef.current) return

    const newAudioState = !isAudioEnabled

    // Toggle local audio tracks
    const audioTracks = localStreamRef.current.getAudioTracks()
    audioTracks.forEach((track) => {
      track.enabled = newAudioState
    })

    // Update all peer connections
    Object.keys(peerConnectionsRef.current).forEach((userId) => {
      const senders = audioSendersRef.current[userId]
      if (senders) {
        senders.forEach((sender) => {
          if (sender.track) {
            sender.track.enabled = newAudioState
          }
        })
      }

      // Notify remote user
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

    // Update all peer connections
    Object.keys(peerConnectionsRef.current).forEach((userId) => {
      const senders = videoSendersRef.current[userId]
      if (senders) {
        senders.forEach((sender) => {
          if (sender.track) {
            sender.track.enabled = newVideoState
          }
        })
      }

      // Notify remote user
      socket.emit("BE-track-state-changed", {
        to: userId,
        trackType: "video",
        enabled: newVideoState,
        callId: call.callId,
      })
    })

    setIsVideoEnabled(newVideoState)
  }

  // Function to restart audio for a specific user
  const restartAudioForUser = (userId) => {
    const peerData = peerConnectionsRef.current[userId]
    if (!peerData) return

    logDebug(`Attempting to restart audio for ${userId}`)

    // Renegotiate connection
    cleanupPeerConnection(userId)

    // Get user info
    const userInfo = participantsMapRef.current.get(userId)
    if (userInfo) {
      setTimeout(() => {
        createPeerConnection(userId, userInfo, true)
      }, 1000)
    }
  }

  // Function to force reconnect all participants
  const forceReconnectAll = () => {
    logDebug("Force reconnecting all participants...")
    setIsReconnecting(true)

    // Clean up all connections
    Object.keys(peerConnectionsRef.current).forEach((userId) => {
      cleanupPeerConnection(userId)
    })

    // Clear processed participants and connection attempts
    processedParticipantsRef.current.clear()
    processedParticipantsRef.current.add(user.id)
    reconnectAttemptsRef.current = {}
    connectionEstablishedRef.current = {}
    connectionStatusRef.current = {}
    lastConnectionAttemptRef.current = {}
    pendingConnectionsRef.current.clear()

    // Clear all timeouts
    Object.values(connectionTimersRef.current).forEach((timeout) => {
      clearTimeout(timeout)
    })
    connectionTimersRef.current = {}

    // Request participants list again
    setTimeout(() => {
      socket.emit("BE-get-call-participants", { callId: call.callId })

      // Reset reconnecting state after some time
      setTimeout(() => {
        setIsReconnecting(false)
      }, 5000)
    }, 1000)
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

    // Clean up audio context
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close()
    }

    // Clear all timeouts
    Object.values(connectionTimersRef.current).forEach((timeout) => {
      clearTimeout(timeout)
    })

    // Clear all intervals
    if (connectionCheckIntervalRef.current) {
      clearInterval(connectionCheckIntervalRef.current)
    }

    // Reset all refs
    peerConnectionsRef.current = {}
    audioSendersRef.current = {}
    videoSendersRef.current = {}
    iceCandidateBuffersRef.current = {}
    audioSourcesRef.current = {}
    processedParticipantsRef.current.clear()
    participantsMapRef.current.clear()
    connectionTimersRef.current = {}
    reconnectAttemptsRef.current = {}
    connectionEstablishedRef.current = {}
    connectionStatusRef.current = {}
    lastConnectionAttemptRef.current = {}
    pendingConnectionsRef.current.clear()
    localStreamRef.current = null
  }

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  // Enhanced video element setup with proper error handling
  const setupVideoElement = (userId, stream) => {
    const videoElement = remoteVideosRef.current[userId]
    if (!videoElement || !stream) return

    // Prevent multiple setups
    if (videoElement.srcObject === stream) return

    try {
      // Clear previous stream
      if (videoElement.srcObject) {
        videoElement.srcObject = null
      }

      // Set new stream
      videoElement.srcObject = stream
      videoElement.muted = false
      videoElement.volume = 1.0
      videoElement.playsInline = true
      videoElement.autoplay = true

      // Handle play with proper error handling
      const playPromise = videoElement.play()
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            logDebug(`Remote video playing for ${userId}`)
          })
          .catch((error) => {
            logDebug(`Play failed for ${userId}, will retry on user interaction:`, error.name)

            // Add click listener to retry play
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

      const peerData = peerConnectionsRef.current[userId]
      const audioStatus = peerData ? peerData.audioConnected : false
      const hasAudio = audioLevels[userId]
      const connectionState = connectionStatusRef.current[userId] || "unknown"

      return (
        <div key={userId} className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
          <video
            ref={(el) => {
              if (el) {
                remoteVideosRef.current[userId] = el
                const stream = remoteStreams[userId]
                if (stream) {
                  // Use setTimeout to avoid conflicts
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
            {call.isGroupCall && !audioStatus && (
              <button
                onClick={() => restartAudioForUser(userId)}
                className="ml-2 text-xs bg-blue-500 px-1 rounded"
                title="Restart audio"
              >
                Fix Audio
              </button>
            )}
          </div>

          {!userState.video && call.callType === "video" && (
            <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
          )}

          {/* Connection status indicator */}
          <div
            className={`absolute top-2 left-2 w-3 h-3 rounded-full ${
              connectionState === "connected" || connectionState === "completed"
                ? hasAudio
                  ? "bg-green-500"
                  : "bg-yellow-500"
                : connectionState === "connecting" || connectionState === "checking"
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-red-500"
            }`}
            title={`Connection: ${connectionState}${hasAudio ? ", Audio detected" : ""}`}
          ></div>
        </div>
      )
    })
  }

  const actualParticipantCount = Object.keys(remoteStreams).length + 1
  const expectedParticipantCount = call.isGroupCall ? processedParticipantsRef.current.size : 2

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
          </p>
          {call.isGroupCall && (
            <p className="text-xs text-gray-400">
              Expected: {expectedParticipantCount} | Connected: {connectionStats.connected}/{connectionStats.expected} |
              Audio: {connectionStats.audioConnected} | Video: {connectionStats.videoConnected} | Failed:{" "}
              {connectionStats.failed}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-300 flex items-center">
            <Users className="w-4 h-4 mr-1" />
            {actualParticipantCount}
          </span>

          {/* Debug toggle */}
          <button
            onClick={() => setShowDebugInfo(!showDebugInfo)}
            className="bg-gray-600 text-white p-1 rounded hover:bg-gray-700"
            title="Toggle debug info"
          >
            <AlertCircle className="w-4 h-4" />
          </button>

          {call.isGroupCall && (
            <button
              onClick={forceReconnectAll}
              disabled={isReconnecting}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
                isReconnecting ? "bg-gray-500 cursor-not-allowed" : "bg-yellow-500 hover:bg-yellow-600"
              }`}
              title="Force reconnect all participants"
            >
              <RefreshCw className={`w-3 h-3 ${isReconnecting ? "animate-spin" : ""}`} />
              {isReconnecting ? "Reconnecting..." : "Reconnect"}
            </button>
          )}
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
            maxHeight: showDebugInfo ? "calc(100vh - 300px)" : "calc(100vh - 160px)",
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
            </div>

            {!isVideoEnabled && call.callType === "video" && (
              <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
            )}
          </div>
        </div>

        {/* Debug info */}
        {showDebugInfo && (
          <div className="bg-gray-800 text-white text-xs p-2 mt-2 rounded h-32 overflow-auto">
            <div className="font-bold mb-1">Debug Log:</div>
            {debugMessages
              .slice()
              .reverse()
              .map((msg, i) => (
                <div key={i} className="mb-1">
                  <span className="text-gray-400">{msg.time}</span> {msg.message}
                  {msg.data && msg.data !== '""' && <span className="text-gray-400"> {msg.data}</span>}
                </div>
              ))}
          </div>
        )}

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
