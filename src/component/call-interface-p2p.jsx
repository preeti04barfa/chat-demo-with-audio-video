import { useEffect, useRef, useState, useCallback } from "react"
import { PhoneOff, Mic, MicOff, Video, VideoOff, AlertCircle } from "lucide-react"

export function CallInterfaceP2P({ call, user, socket, onEndCall }) {
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const localStreamRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const audioSenderRef = useRef(null)
  const videoSenderRef = useRef(null)

  const [isAudioEnabled, setIsAudioEnabled] = useState(true)
  const [isVideoEnabled, setIsVideoEnabled] = useState(call.callType === "video")
  const [callDuration, setCallDuration] = useState(0)
  const [remoteStream, setRemoteStream] = useState(null)
  const [remoteUserState, setRemoteUserState] = useState({
    audio: true,
    video: call.callType === "video",
  })
  const [connectionStatus, setConnectionStatus] = useState("connecting")
  const [permissionError, setPermissionError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)

  const logDebug = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
    console.log(`[P2P ${timestamp}] ${message}`, data || "")
  }, [])

  useEffect(() => {
    if (!call || !call.caller || !call.receiver) {
      logDebug("Invalid call structure for P2P call:", call)
      setPermissionError("Invalid call configuration. This appears to be a group call.")
      return
    }

    if (call.isGroupCall || call.groupId || call.usesMediasoup) {
      logDebug("This is a group call, should not be in P2P interface")
      setPermissionError("This is a group call and should use the group call interface.")
      return
    }

    initializeCall()

    const timer = setInterval(() => {
      setCallDuration((prev) => prev + 1)
    }, 1000)

    return () => {
      clearInterval(timer)
      cleanup()
    }
  }, [])


  useEffect(() => {
    if (permissionError && retryCount < 3 && !permissionError.includes("group call")) {
      const timer = setTimeout(() => {
        logDebug(`Retrying media access (attempt ${retryCount + 1})`)
        setRetryCount((prev) => prev + 1)
        initializeCall(true)
      }, 1000)

      return () => clearTimeout(timer)
    }
  }, [permissionError, retryCount])

  useEffect(() => {
    if (!socket) return

    socket.on("FE-user-joined-call", ({ userId, userInfo }) => {
      logDebug(`User joined call: ${userId}`, userInfo)
      setTimeout(() => {
        createPeerConnection(userId, userInfo)
      }, 300)
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
      setRemoteUserState((prev) => ({
        ...prev,
        [trackType]: enabled,
      }))
    })

    return () => {
      socket.off("FE-user-joined-call")
      socket.off("FE-webrtc-offer")
      socket.off("FE-webrtc-answer")
      socket.off("FE-webrtc-ice-candidate")
      socket.off("FE-track-state-changed")
    }
  }, [socket])

  const initializeCall = async (isRetry = false) => {
    try {
      if (!call || !call.caller || !call.receiver) {
        throw new Error("Invalid call structure for P2P call")
      }

      logDebug(`Initializing P2P call${isRetry ? " (retry)" : ""}`)
      setPermissionError(null)

      let stream

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
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        logDebug("Media access granted successfully")
      } catch (mediaError) {
        if (call.callType === "video" && !isRetry) {
          logDebug("Video access failed, trying audio only as fallback", mediaError)
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false,
            })
            setIsVideoEnabled(false)
            logDebug("Audio-only fallback successful")
          } catch (audioOnlyError) {
            throw new Error("Both video and audio access failed")
          }
        } else if (call.callType === "audio") {
          throw mediaError
        } else {
          throw mediaError
        }
      }

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

      const otherUserId = call.caller.id === user.id ? call.receiver?._id : call.caller?._id
      const otherUserInfo = call.caller.id === user.id ? call.receiver : call.caller

      if (!otherUserId || !otherUserInfo) {
        throw new Error("Cannot determine other user in P2P call")
      }

      setTimeout(() => {
        createPeerConnection(otherUserId, otherUserInfo)
      }, 200)
    } catch (error) {
      logDebug("Error accessing media devices:", error)

      let errorMessage = "Could not access camera/microphone. Please check your permissions and try again."

      if (error.message.includes("Invalid call structure")) {
        errorMessage = "This call cannot be handled as a P2P call. Please try again."
      } else if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorMessage = "Permission denied. Please allow access to your camera/microphone in your browser settings."
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorMessage = "No camera or microphone found. Please connect a device and try again."
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorMessage = "Your camera or microphone is already in use by another application."
      } else if (error.name === "OverconstrainedError") {
        errorMessage = "The requested media settings are not supported by your device."
      }

      setPermissionError(errorMessage)

      if (retryCount >= 2 || !isRetry) {
        alert(errorMessage)
        onEndCall()
      }
    }
  }

  const createPeerConnection = async (userId, userInfo) => {
    try {
      logDebug(`Creating peer connection for user ${userId}`)
      setConnectionStatus("connecting")

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
      peerConnectionRef.current = peerConnection

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          const sender = peerConnection.addTrack(track, localStreamRef.current)
          if (track.kind === "audio") {
            audioSenderRef.current = sender
          } else {
            videoSenderRef.current = sender
          }
        })
      }

      peerConnection.ontrack = (event) => {
        logDebug(`Received track from ${userId}`, event)
        const [remoteStream] = event.streams

        if (remoteStream) {
          setRemoteStream(remoteStream)
          setConnectionStatus("connected")
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
        logDebug(`ICE connection state: ${peerConnection.iceConnectionState}`)
        if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
          setConnectionStatus("connected")
        } else if (
          peerConnection.iceConnectionState === "disconnected" ||
          peerConnection.iceConnectionState === "failed"
        ) {
          setConnectionStatus("disconnected")
        }
      }

      if (call.caller.id === user.id) {
        setTimeout(() => {
          createOffer(userId, peerConnection)
        }, 500)
      }

      return peerConnection
    } catch (error) {
      logDebug(`Error creating peer connection for ${userId}:`, error)
      setConnectionStatus("failed")
    }
  }

  const createOffer = async (userId, peerConnection) => {
    try {
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: call.callType === "video",
      })

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

  const handleOffer = async (userId, offer) => {
    try {
      if (!peerConnectionRef.current) {
        const otherUserInfo = call.caller.id === user.id ? call.receiver : call.caller
        await createPeerConnection(userId, otherUserInfo)
      }

      const peerConnection = peerConnectionRef.current
      if (!peerConnection) return

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))

      const answer = await peerConnection.createAnswer()
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

  const handleAnswer = async (userId, answer) => {
    try {
      const peerConnection = peerConnectionRef.current
      if (!peerConnection || peerConnection.signalingState !== "have-local-offer") return

      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
    } catch (error) {
      logDebug(`Error handling answer from ${userId}:`, error)
    }
  }

  const handleIceCandidate = async (userId, candidate) => {
    try {
      const peerConnection = peerConnectionRef.current
      if (!peerConnection) return

      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (error) {
      logDebug(`Error handling ICE candidate from ${userId}:`, error)
    }
  }

  const toggleAudio = () => {
    if (!localStreamRef.current) return

    const newAudioState = !isAudioEnabled

    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = newAudioState
    })

    if (audioSenderRef.current && audioSenderRef.current.track) {
      audioSenderRef.current.track.enabled = newAudioState
    }

    const otherUserId = call.caller.id === user.id ? call.receiver?._id : call.caller?._id
    if (otherUserId) {
      socket.emit("BE-track-state-changed", {
        to: otherUserId,
        trackType: "audio",
        enabled: newAudioState,
        callId: call.callId,
      })
    }

    setIsAudioEnabled(newAudioState)
  }

  const toggleVideo = () => {
    if (!localStreamRef.current || call.callType !== "video") return

    const newVideoState = !isVideoEnabled
    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = newVideoState
    })

    if (videoSenderRef.current && videoSenderRef.current.track) {
      videoSenderRef.current.track.enabled = newVideoState
    }

    const otherUserId = call.caller.id === user.id ? call.receiver?._id : call.caller?._id
    if (otherUserId) {
      socket.emit("BE-track-state-changed", {
        to: otherUserId,
        trackType: "video",
        enabled: newVideoState,
        callId: call.callId,
      })
    }

    setIsVideoEnabled(newVideoState)
  }

  const cleanup = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop()
      })
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
    }

    if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
      remoteVideoRef.current.srcObject.getTracks().forEach((track) => track.stop())
      remoteVideoRef.current.srcObject = null
    }

    localStreamRef.current = null
    peerConnectionRef.current = null
    audioSenderRef.current = null
    videoSenderRef.current = null
  }

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  const setupRemoteVideo = (stream) => {
    if (!remoteVideoRef.current || !stream) return

    if (remoteVideoRef.current.srcObject === stream) return

    try {
      if (remoteVideoRef.current.srcObject) {
        remoteVideoRef.current.srcObject.getTracks().forEach((track) => track.stop())
        remoteVideoRef.current.srcObject = null
      }

      remoteVideoRef.current.srcObject = stream
      remoteVideoRef.current.muted = false
      remoteVideoRef.current.volume = 1.0
      remoteVideoRef.current.playsInline = true
      remoteVideoRef.current.autoplay = true

      const playPromise = remoteVideoRef.current.play()
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          console.log("Video play failed, will retry on user interaction:", error)
          const retryPlay = () => {
            if (remoteVideoRef.current) {
              remoteVideoRef.current.play().catch(console.error)
            }
            document.removeEventListener("click", retryPlay)
          }
          document.addEventListener("click", retryPlay, { once: true })
        })
      }
    } catch (error) {
      logDebug(`Error setting up remote video:`, error)
    }
  }

  useEffect(() => {
    if (remoteStream) {
      setupRemoteVideo(remoteStream)
    }
  }, [remoteStream])

  const getOtherUserName = () => {
    if (!call || !call.caller || !call.receiver) return "Unknown User"

    const otherUser = call.caller.id === user.id ? call.receiver : call.caller
    return otherUser?.name || "Unknown User"
  }

  if (permissionError) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {call?.callType ? call.callType.charAt(0).toUpperCase() + call.callType.slice(1) : "Audio"} call
            </h2>
          </div>
          <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="bg-gray-800 p-6 rounded-lg max-w-md w-full text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-white mb-2">Call Error</h3>
            <p className="text-gray-300 mb-4">{permissionError}</p>
            <div className="flex flex-col gap-3">
              {!permissionError.includes("group call") && (
                <button
                  onClick={() => initializeCall(true)}
                  className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded"
                >
                  Retry
                </button>
              )}
              <button onClick={onEndCall} className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded">
                End Call
              </button>
            </div>
            {!permissionError.includes("group call") && (
              <p className="text-gray-400 text-sm mt-4">
                Try opening your browser settings and allowing access to your camera/microphone
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {call?.callType ? call.callType.charAt(0).toUpperCase() + call.callType.slice(1) : "Audio"} call with{" "}
            {getOtherUserName()}
          </h2>
          <p className="text-sm text-gray-300">
            {formatDuration(callDuration)} • P2P Connection • {connectionStatus}
          </p>
        </div>
        <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
          <PhoneOff className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 p-2 flex flex-col overflow-hidden">
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2 overflow-hidden">
      
          <div className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${call?.callType === "audio" || !isVideoEnabled ? "hidden" : ""}`}
            />

            {(call?.callType === "audio" || !isVideoEnabled) && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                <div className="w-16 h-16 bg-blue-500 text-white rounded-full flex items-center justify-center text-xl font-bold">
                  {user?.name ? user.name.charAt(0).toUpperCase() : "U"}
                </div>
              </div>
            )}

            <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded flex items-center">
              You
              {!isAudioEnabled && <span className="ml-1">(Muted)</span>}
            </div>

            {!isVideoEnabled && call?.callType === "video" && (
              <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
            )}

            <div
              className={`absolute top-2 left-2 w-3 h-3 rounded-full ${
                connectionStatus === "connected" ? "bg-green-500" : "bg-yellow-500 animate-pulse"
              }`}
              title={`Connection: ${connectionStatus}`}
            />
          </div>

          <div className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={`w-full h-full object-cover ${
                call?.callType === "audio" || !remoteUserState.video ? "hidden" : ""
              }`}
            />

            {(call?.callType === "audio" || !remoteUserState.video) && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                <div className="w-16 h-16 bg-green-500 text-white rounded-full flex items-center justify-center text-xl font-bold">
                  {getOtherUserName().charAt(0).toUpperCase()}
                </div>
              </div>
            )}

            <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded flex items-center">
              {getOtherUserName()}
              {!remoteUserState.audio && <span className="ml-1">(Muted)</span>}
            </div>

            {!remoteUserState.video && call?.callType === "video" && (
              <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
            )}

            {!remoteStream && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                <div className="text-white text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-2"></div>
                  <p>Connecting...</p>
                </div>
              </div>
            )}
          </div>
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

          {call?.callType === "video" && (
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
