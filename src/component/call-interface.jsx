"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { PhoneOff, Mic, MicOff, Video, VideoOff, Users } from "lucide-react"
import { Device } from "mediasoup-client"

export function CallInterface({ call, user, socket, onEndCall }) {
  const localVideoRef = useRef(null)
  const remoteVideosRef = useRef({})
  const localStreamRef = useRef(null)
  const containerRef = useRef(null)
  const audioContextRef = useRef(null)
  const audioDestinationRef = useRef(null)
  const audioSourcesRef = useRef({})

  // P2P specific refs (for one-to-one calls)
  const peerConnectionsRef = useRef({})

  // SFU specific refs (for group calls)
  const deviceRef = useRef(null)
  const sendTransportRef = useRef(null)
  const recvTransportRef = useRef(null)
  const producersRef = useRef({})
  const consumersRef = useRef({})

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
  const [isConnecting, setIsConnecting] = useState(true)

  // logging function
  const logDebug = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage, data || "")

    setDebugMessages((prev) => {
      const newMessages = [...prev, { time: timestamp, message, data: JSON.stringify(data || "") }]
      return newMessages.slice(-50) // last 50 messages
    })
  }, [])

  // Calculate grid layout based on number of participants
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

  // Initialize audio context for better audio handling
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

  // Socket event listeners
  useEffect(() => {
    if (!socket) return

    socket.on("FE-user-joined-call", ({ userId, userInfo }) => {
      logDebug(`User joined call: ${userId}`, userInfo)

      // Add to connected users if not already present
      setConnectedUsers((prev) => {
        if (prev.some((u) => u._id === userId || u.id === userId)) {
          return prev
        }
        return [...prev, userInfo]
      })

      // For one-to-one calls, create a direct connection
      if (!call.isGroupCall) {
        setTimeout(() => {
          createPeerConnection(userId, userInfo)
        }, 300)
      }
    })

    socket.on("FE-user-left-call", ({ userId }) => {
      logDebug(`User left call: ${userId}`)

      setConnectedUsers((prev) => prev.filter((u) => u._id !== userId && u.id !== userId))

      // Remove stream for this user
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

      // Clean up video element
      if (remoteVideosRef.current[userId]) {
        const videoElement = remoteVideosRef.current[userId]
        if (videoElement.srcObject) {
          videoElement.srcObject = null
        }
        delete remoteVideosRef.current[userId]
      }

      // Clean up peer connection for P2P calls
      if (peerConnectionsRef.current[userId]) {
        peerConnectionsRef.current[userId].close()
        delete peerConnectionsRef.current[userId]
      }

      // Close consumer if exists (for SFU calls)
      if (consumersRef.current[userId]) {
        Object.values(consumersRef.current[userId]).forEach((consumer) => {
          if (consumer) {
            consumer.close()
          }
        })
        delete consumersRef.current[userId]
      }
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

    // P2P specific events (for one-to-one calls)
    socket.on("FE-webrtc-offer", async ({ from, offer }) => {
      logDebug(`Received offer from: ${from}`, offer)
      if (!call.isGroupCall) {
        await handleOffer(from, offer)
      }
    })

    socket.on("FE-webrtc-answer", async ({ from, answer }) => {
      logDebug(`Received answer from: ${from}`, answer)
      if (!call.isGroupCall) {
        await handleAnswer(from, answer)
      }
    })

    socket.on("FE-webrtc-ice-candidate", async ({ from, candidate }) => {
      logDebug(`Received ICE candidate from: ${from}`, candidate)
      if (!call.isGroupCall) {
        await handleIceCandidate(from, candidate)
      }
    })

    // SFU specific events (for group calls)
    socket.on("FE-router-rtpCapabilities", async ({ rtpCapabilities }) => {
      if (!call.isGroupCall) return

      try {
        logDebug("Received router RTP capabilities", rtpCapabilities)

        // Load the device with the router's RTP capabilities
        await deviceRef.current.load({ routerRtpCapabilities: rtpCapabilities })

        // Create send transport
        socket.emit("BE-create-transport", {
          callId: call.callId,
          direction: "send",
        })
      } catch (error) {
        logDebug("Error loading device:", error)
      }
    })

    socket.on("FE-transport-created", async ({ direction, transport }) => {
      if (!call.isGroupCall) return

      try {
        logDebug(`Transport created: ${direction}`, transport)

        if (direction === "send") {
          // Check if send transport already exists
          if (sendTransportRef.current) {
            logDebug("Send transport already exists, skipping creation")
            return
          }

          // Create the send transport
          const sendTransport = deviceRef.current.createSendTransport(transport)

          sendTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
              logDebug("Send transport connect event", dtlsParameters)

              socket.emit("BE-connect-transport", {
                callId: call.callId,
                transportId: sendTransport.id,
                dtlsParameters,
              })

              // Wait for connection confirmation
              const connectionPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  reject(new Error("Transport connection timeout"))
                }, 10000)

                socket.once("FE-transport-connected", ({ transportId }) => {
                  clearTimeout(timeout)
                  if (transportId === sendTransport.id) {
                    resolve()
                  }
                })

                socket.once("FE-error", ({ message }) => {
                  clearTimeout(timeout)
                  reject(new Error(message))
                })
              })

              await connectionPromise
              callback()
            } catch (error) {
              logDebug("Send transport connect error:", error)
              errback(error)
            }
          })

          sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
            try {
              logDebug(`Send transport produce event: ${kind}`, { rtpParameters, appData })

              socket.emit("BE-produce", {
                callId: call.callId,
                transportId: sendTransport.id,
                kind,
                rtpParameters,
                appData,
              })

              socket.once("FE-producer-created", ({ id }) => {
                logDebug(`Producer created with id: ${id}`)
                callback({ id })
              })
            } catch (error) {
              logDebug("Send transport produce error:", error)
              errback(error)
            }
          })

          sendTransportRef.current = sendTransport

          // Now create receive transport
          socket.emit("BE-create-transport", {
            callId: call.callId,
            direction: "recv",
          })
        } else if (direction === "recv") {
          // Check if receive transport already exists
          if (recvTransportRef.current) {
            logDebug("Receive transport already exists, skipping creation")
            return
          }

          // Create the receive transport
          const recvTransport = deviceRef.current.createRecvTransport(transport)

          recvTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
            try {
              logDebug("Receive transport connect event", dtlsParameters)

              socket.emit("BE-connect-transport", {
                callId: call.callId,
                transportId: recvTransport.id,
                dtlsParameters,
              })

              // Wait for connection confirmation
              const connectionPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  reject(new Error("Transport connection timeout"))
                }, 10000)

                socket.once("FE-transport-connected", ({ transportId }) => {
                  clearTimeout(timeout)
                  if (transportId === recvTransport.id) {
                    resolve()
                  }
                })

                socket.once("FE-error", ({ message }) => {
                  clearTimeout(timeout)
                  reject(new Error(message))
                })
              })

              await connectionPromise
              callback()
            } catch (error) {
              logDebug("Receive transport connect error:", error)
              errback(error)
            }
          })

          recvTransportRef.current = recvTransport

          // Now that we have both transports, produce our media
          await produceLocalMedia()

          setIsConnecting(false)
        }
      } catch (error) {
        logDebug(`Error creating ${direction} transport:`, error)
        alert(`Failed to create ${direction} transport: ${error.message}`)
      }
    })

    socket.on("FE-transport-connected", ({ transportId }) => {
      logDebug(`Transport connected: ${transportId}`)
    })

    socket.on("FE-new-producer", async ({ producerId, userId, kind }) => {
      if (!call.isGroupCall) return

      logDebug(`New producer: ${producerId} from user ${userId}, kind: ${kind}`)

      // Consume this producer
      await consumeProducer(producerId, userId, kind)
    })

    socket.on("FE-consumer-created", async ({ id, producerId, kind, rtpParameters, producerUserId }) => {
      if (!call.isGroupCall) return

      logDebug(`Consumer created: ${id} for producer ${producerId} from user ${producerUserId}`)

      try {
        // Receive the media
        const consumer = await recvTransportRef.current.consume({
          id,
          producerId,
          kind,
          rtpParameters,
        })

        // Store the consumer
        if (!consumersRef.current[producerUserId]) {
          consumersRef.current[producerUserId] = {}
        }
        consumersRef.current[producerUserId][kind] = consumer

        // Create a new stream for this consumer
        const stream = new MediaStream([consumer.track])

        // Store the stream
        setRemoteStreams((prev) => ({
          ...prev,
          [producerUserId]: prev[producerUserId]
            ? new MediaStream([...prev[producerUserId].getTracks(), consumer.track])
            : stream,
        }))

        // Initialize remote user state if not exists
        setRemoteUserStates((prev) => ({
          ...prev,
          [producerUserId]: prev[producerUserId] || {
            audio: kind === "audio",
            video: kind === "video" && call.callType === "video",
          },
        }))

        // Resume the consumer
        socket.emit("BE-resume-consumer", {
          callId: call.callId,
          consumerId: id,
        })
      } catch (error) {
        logDebug(`Error consuming producer ${producerId}:`, error)
      }
    })

    socket.on("FE-consumer-resumed", ({ consumerId }) => {
      logDebug(`Consumer resumed: ${consumerId}`)
    })

    socket.on("FE-error", ({ message }) => {
      logDebug("Received error from server:", message)
      alert(`Call error: ${message}`)
    })

    return () => {
      socket.off("FE-user-joined-call")
      socket.off("FE-user-left-call")
      socket.off("FE-track-state-changed")
      socket.off("FE-webrtc-offer")
      socket.off("FE-webrtc-answer")
      socket.off("FE-webrtc-ice-candidate")
      socket.off("FE-router-rtpCapabilities")
      socket.off("FE-transport-created")
      socket.off("FE-transport-connected")
      socket.off("FE-new-producer")
      socket.off("FE-consumer-created")
      socket.off("FE-consumer-resumed")
      socket.off("FE-error")
    }
  }, [socket, call.isGroupCall, call.callId, call.callType, user.id, logDebug])

  // Monitor audio levels
  useEffect(() => {
    const audioLevelInterval = setInterval(() => {
      Object.keys(remoteStreams).forEach((userId) => {
        const stream = remoteStreams[userId]
        if (stream && stream.getAudioTracks().length > 0) {
          const audioTrack = stream.getAudioTracks()[0]

          // Check if audio track is enabled and active
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
      // Enhanced audio constraints for better quality and noise suppression
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

      // Ensure audio tracks are enabled and properly configured
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

      // Join the call room
      socket.emit("BE-join-call", {
        callId: call.callId,
        userId: user.id,
        userInfo: user,
      })

      if (call.isGroupCall) {
        // For group calls, use SFU with mediasoup
        deviceRef.current = new Device()

        // Get router RTP capabilities
        socket.emit("BE-get-router-rtpCapabilities", {
          callId: call.callId,
        })
      } else {
        // For one-to-one calls, use P2P
        const otherUserId = call.caller.id === user.id ? call.receiver._id : call.caller._id
        const otherUserInfo = call.caller.id === user.id ? call.receiver : call.caller

        setRemoteUserStates({
          [otherUserId]: {
            audio: true,
            video: call.callType === "video",
          },
        })

        setConnectedUsers([otherUserInfo])
        setIsConnecting(false)

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

  // SFU specific: Produce local media using mediasoup
  const produceLocalMedia = async () => {
    try {
      if (!sendTransportRef.current || !localStreamRef.current) {
        logDebug("Cannot produce media: transport or stream not ready")
        return
      }

      // Produce audio
      if (localStreamRef.current.getAudioTracks().length > 0) {
        const audioTrack = localStreamRef.current.getAudioTracks()[0]
        const audioProducer = await sendTransportRef.current.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: true,
            opusDtx: true,
            opusFec: true,
            opusNack: true,
          },
          appData: { mediaTag: "audio" },
        })

        producersRef.current.audio = audioProducer

        audioProducer.on("transportclose", () => {
          logDebug("Audio producer transport closed")
          producersRef.current.audio = null
        })

        audioProducer.on("trackended", () => {
          logDebug("Audio track ended")
          closeProducer("audio")
        })

        // Notify server about track state change
        socket.emit("BE-track-state-changed", {
          callId: call.callId,
          trackType: "audio",
          enabled: isAudioEnabled,
        })
      }

      // Produce video
      if (localStreamRef.current.getVideoTracks().length > 0 && call.callType === "video") {
        const videoTrack = localStreamRef.current.getVideoTracks()[0]
        const videoProducer = await sendTransportRef.current.produce({
          track: videoTrack,
          encodings: [{ maxBitrate: 1000000 }, { maxBitrate: 3000000 }],
          appData: { mediaTag: "video" },
        })

        producersRef.current.video = videoProducer

        videoProducer.on("transportclose", () => {
          logDebug("Video producer transport closed")
          producersRef.current.video = null
        })

        videoProducer.on("trackended", () => {
          logDebug("Video track ended")
          closeProducer("video")
        })

        // Notify server about track state change
        socket.emit("BE-track-state-changed", {
          callId: call.callId,
          trackType: "video",
          enabled: isVideoEnabled,
        })
      }
    } catch (error) {
      logDebug("Error producing media:", error)
    }
  }

  // SFU specific: Consume a producer
  const consumeProducer = async (producerId, userId, kind) => {
    try {
      if (!recvTransportRef.current || !deviceRef.current) {
        logDebug("Cannot consume producer: transport or device not ready")
        return
      }

      // Ask the server to create a consumer
      socket.emit("BE-consume", {
        callId: call.callId,
        producerId,
        rtpCapabilities: deviceRef.current.rtpCapabilities,
      })
    } catch (error) {
      logDebug(`Error consuming producer ${producerId}:`, error)
    }
  }

  // SFU specific: Close a producer
  const closeProducer = (kind) => {
    if (producersRef.current[kind]) {
      producersRef.current[kind].close()
      producersRef.current[kind] = null
    }
  }

  // P2P specific: Create peer connection for one-to-one calls
  const createPeerConnection = async (userId, userInfo, shouldInitiateOffer = null) => {
    try {
      logDebug(`Creating peer connection for user ${userId}`, { userInfo, shouldInitiateOffer })

      // Enhanced ICE servers configuration for better connectivity
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
      peerConnectionsRef.current[userId] = peerConnection

      // Add local stream tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          logDebug(`Adding ${track.kind} track to peer connection for ${userId}`)
          peerConnection.addTrack(track, localStreamRef.current)
        })
      }

      // Handle incoming tracks
      peerConnection.ontrack = (event) => {
        logDebug(`Received ${event.track.kind} track from ${userId}`)
        const [remoteStream] = event.streams

        if (remoteStream) {
          logDebug(`Setting remote stream for ${userId}`)

          setRemoteStreams((prev) => ({
            ...prev,
            [userId]: remoteStream,
          }))

          // Initialize remote user state
          setRemoteUserStates((prev) => ({
            ...prev,
            [userId]: {
              audio: true,
              video: call.callType === "video",
            },
          }))
        }
      }

      // ICE candidate handling
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

      // Connection state monitoring
      peerConnection.oniceconnectionstatechange = () => {
        logDebug(`ICE connection state for ${userId}: ${peerConnection.iceConnectionState}`)
      }

      // In one-to-one calls, caller creates offer
      shouldInitiateOffer = call.caller.id === user.id

      // Create offer with a slight delay
      if (shouldInitiateOffer) {
        setTimeout(() => {
          createOffer(userId, peerConnection)
        }, 500)
      }

      return peerConnection
    } catch (error) {
      logDebug(`Error creating peer connection for ${userId}:`, error)
    }
  }

  // P2P specific: Create offer for one-to-one calls
  const createOffer = async (userId, peerConnection) => {
    try {
      logDebug(`Creating offer for ${userId}`)

      // Enhanced SDP options for better audio
      const offerOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.callType === "video",
        voiceActivityDetection: true,
      }

      const offer = await peerConnection.createOffer(offerOptions)

      // Modify SDP to prioritize audio and reduce noise
      offer.sdp = enhanceAudioSdp(offer.sdp)

      await peerConnection.setLocalDescription(offer)

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

  // P2P specific: Handle offer for one-to-one calls
  const handleOffer = async (userId, offer) => {
    try {
      logDebug(`Handling offer from ${userId}`)

      // Create peer connection if it doesn't exist
      let peerConnection = peerConnectionsRef.current[userId]
      if (!peerConnection) {
        peerConnection = await createPeerConnection(userId, null, false)
      }

      if (!peerConnection) {
        logDebug(`Failed to create peer connection for ${userId}`)
        return
      }

      // Enhance audio in SDP
      offer.sdp = enhanceAudioSdp(offer.sdp)

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))

      // Create answer
      const answerOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.callType === "video",
        voiceActivityDetection: true,
      }

      const answer = await peerConnection.createAnswer(answerOptions)

      // Enhance audio in SDP
      answer.sdp = enhanceAudioSdp(answer.sdp)

      await peerConnection.setLocalDescription(answer)

      socket.emit("BE-webrtc-answer", {
        to: userId,
        answer: answer,
        callId: call.callId,
      })

      logDebug(`Answer sent to ${userId}`)
    } catch (error) {
      logDebug(`Error handling offer from ${userId}:`, error)
    }
  }

  // P2P specific: Handle answer for one-to-one calls
  const handleAnswer = async (userId, answer) => {
    try {
      logDebug(`Processing answer from ${userId}`)

      const peerConnection = peerConnectionsRef.current[userId]
      if (!peerConnection) {
        logDebug(`No peer connection found for ${userId}`)
        return
      }

      // Enhance audio in SDP
      answer.sdp = enhanceAudioSdp(answer.sdp)

      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
      logDebug(`Answer processed successfully for ${userId}`)
    } catch (error) {
      logDebug(`Error handling answer from ${userId}:`, error)
    }
  }

  // P2P specific: Handle ICE candidate for one-to-one calls
  const handleIceCandidate = async (userId, candidate) => {
    try {
      const peerConnection = peerConnectionsRef.current[userId]
      if (!peerConnection) {
        logDebug(`No peer connection found for ${userId}`)
        return
      }

      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
      logDebug(`Added ICE candidate for ${userId}`)
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

    setIsAudioEnabled(newAudioState)

    // Notify server about track state change
    if (call.isGroupCall) {
      socket.emit("BE-track-state-changed", {
        callId: call.callId,
        trackType: "audio",
        enabled: newAudioState,
      })
    } else {
      // For one-to-one calls, notify the other participant
      const otherUserId = call.caller.id === user.id ? call.receiver._id : call.caller._id
      socket.emit("BE-track-state-changed", {
        to: otherUserId,
        trackType: "audio",
        enabled: newAudioState,
        callId: call.callId,
      })
    }
  }

  const toggleVideo = () => {
    if (!localStreamRef.current || call.callType !== "video") return

    const newVideoState = !isVideoEnabled
    const videoTracks = localStreamRef.current.getVideoTracks()

    videoTracks.forEach((track) => {
      track.enabled = newVideoState
    })

    setIsVideoEnabled(newVideoState)

    // Notify server about track state change
    if (call.isGroupCall) {
      socket.emit("BE-track-state-changed", {
        callId: call.callId,
        trackType: "video",
        enabled: newVideoState,
      })
    } else {
      // For one-to-one calls, notify the other participant
      const otherUserId = call.caller.id === user.id ? call.receiver._id : call.caller._id
      socket.emit("BE-track-state-changed", {
        to: otherUserId,
        trackType: "video",
        enabled: newVideoState,
        callId: call.callId,
      })
    }
  }

  const cleanup = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop()
      })
    }

    // Clean up P2P connections
    Object.values(peerConnectionsRef.current).forEach((pc) => {
      if (pc) {
        pc.close()
      }
    })
    peerConnectionsRef.current = {}

    // Clean up SFU connections
    if (sendTransportRef.current) {
      sendTransportRef.current.close()
      sendTransportRef.current = null
    }

    if (recvTransportRef.current) {
      recvTransportRef.current.close()
      recvTransportRef.current = null
    }

    // Clean up producers
    Object.values(producersRef.current).forEach((producer) => {
      if (producer) {
        producer.close()
      }
    })
    producersRef.current = {}

    // Clean up consumers
    // Clean up producers
    Object.values(producersRef.current).forEach((producer) => {
      if (producer) {
        producer.close()
      }
    })
    producersRef.current = {}

    // Clean up consumers
    Object.values(consumersRef.current).forEach((userConsumers) => {
      Object.values(userConsumers).forEach((consumer) => {
        if (consumer) {
          consumer.close()
        }
      })
    })
    consumersRef.current = {}

    // Clean up audio context
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close()
    }
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
      const userInfo = connectedUsers.find((u) => u._id === userId || u.id === userId) || { name: "User", id: userId }

      const hasAudio = audioLevels[userId]

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
          </div>

          {!userState.video && call.callType === "video" && (
            <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
          )}

          {/* Audio indicator */}
          <div
            className={`absolute top-2 left-2 w-3 h-3 rounded-full ${hasAudio ? "bg-green-500" : "bg-yellow-500"}`}
            title={hasAudio ? "Audio detected" : "No audio detected"}
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
            {call.isGroupCall && isConnecting && " • Connecting..."}
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
