import { useEffect, useRef, useState } from "react"
import { PhoneOff, Mic, MicOff, Video, VideoOff } from "lucide-react"

export function CallInterface({ call, user, socket, onEndCall }) {
  const localVideoRef = useRef(null)
  const remoteVideosRef = useRef({})
  const localStreamRef = useRef(null)
  const peerConnectionsRef = useRef({})
  const audioSendersRef = useRef({})

  const [isAudioEnabled, setIsAudioEnabled] = useState(true)
  const [isVideoEnabled, setIsVideoEnabled] = useState(call.callType === "video")
  const [connectedUsers, setConnectedUsers] = useState([])
  const [callDuration, setCallDuration] = useState(0)
  const [remoteStreams, setRemoteStreams] = useState({})
  const [remoteUserStates, setRemoteUserStates] = useState({})

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

  useEffect(() => {
    if (!socket) return

    socket.on("FE-user-joined-call", ({ userId, userInfo }) => {
      console.log("User joined call:", userId, userInfo)
      setConnectedUsers((prev) => [...prev.filter((u) => u.id !== userId), userInfo])
      if (!peerConnectionsRef.current[userId]) {
        createPeerConnection(userId)
      }
    })

    socket.on("FE-user-left-call", ({ userId }) => {
      console.log("User left call:", userId)
      setConnectedUsers((prev) => prev.filter((u) => u.id !== userId))
      if (peerConnectionsRef.current[userId]) {
        peerConnectionsRef.current[userId].connection.close()
        delete peerConnectionsRef.current[userId]
        delete audioSendersRef.current[userId]
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
      }
    })

    socket.on("FE-webrtc-offer", async ({ from, offer }) => {
      console.log("Received offer from:", from)
      await handleOffer(from, offer)
    })

    socket.on("FE-webrtc-answer", async ({ from, answer }) => {
      console.log("Received answer from:", from)
      await handleAnswer(from, answer)
    })

    socket.on("FE-webrtc-ice-candidate", async ({ from, candidate }) => {
      console.log("Received ICE candidate from:", from)
      await handleIceCandidate(from, candidate)
    })

    //track state change handling
    socket.on("FE-track-state-changed", ({ from, trackType, enabled }) => {
      console.log(`Track state changed from ${from}: ${trackType} = ${enabled}`)

      //remote user state
      setRemoteUserStates((prev) => ({
        ...prev,
        [from]: {
          ...prev[from],
          [trackType]: enabled,
        },
      }))

      // If this is an audio track, mute/unmute the audio element
      if (trackType === "audio" && remoteVideosRef.current[from]) {
        const videoElement = remoteVideosRef.current[from]
        if (videoElement && videoElement.srcObject) {
          const audioTracks = videoElement.srcObject.getAudioTracks()
          audioTracks.forEach((track) => {
            track.enabled = enabled
            console.log(`Remote audio track ${enabled ? "enabled" : "disabled"} for ${from}`)
          })
        }
      }
    })

    return () => {
      socket.off("FE-user-joined-call")
      socket.off("FE-user-left-call")
      socket.off("FE-webrtc-offer")
      socket.off("FE-webrtc-answer")
      socket.off("FE-webrtc-ice-candidate")
      socket.off("FE-track-state-changed")
    }
  }, [socket])

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

      console.log("Requesting media with constraints:", constraints)
      const stream = await navigator.mediaDevices.getUserMedia(constraints)

      localStreamRef.current = stream

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
        localVideoRef.current.muted = true
      }

      // Join the call room
      socket.emit("BE-join-call", {
        callId: call.callId,
        userId: user.id,
        userInfo: user,
      })

      // Initialize remote user states
      if (!call.isGroupCall) {
        const otherUserId = call.caller.id === user.id ? call.receiver._id : call.caller._id
        setRemoteUserStates({
          [otherUserId]: {
            audio: true,
            video: call.callType === "video",
          },
        })
        createPeerConnection(otherUserId)
      }
    } catch (error) {
      console.error("Error accessing media devices:", error)
      alert("Could not access camera/microphone. Please check your permissions and try again.")
      onEndCall()
    }
  }

  const createPeerConnection = async (userId) => {
    try {
      if (peerConnectionsRef.current[userId]) {
        console.log(`Peer connection for user ${userId} already exists, skipping creation.`)
        return
      }

      console.log(`Creating peer connection for user ${userId}`)

      const configuration = {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          {
            urls: "turn:numb.viagenie.ca",
            credential: "muazkh",
            username: "webrtc@live.com",
          },
        ],
        iceCandidatePoolSize: 10,
      }

      const peerConnection = new RTCPeerConnection(configuration)

      peerConnectionsRef.current[userId] = {
        userId,
        connection: peerConnection,
        iceCandidateQueue: [],
        remoteDescriptionSet: false,
      }

      // Add local tracks to the peer connection and store senders
      if (localStreamRef.current) {
        audioSendersRef.current[userId] = []

        localStreamRef.current.getTracks().forEach((track) => {
          console.log(`Adding ${track.kind} track to peer connection for ${userId}`)
          const sender = peerConnection.addTrack(track, localStreamRef.current)

          // Store audio senders for mute functionality
          if (track.kind === "audio") {
            audioSendersRef.current[userId].push(sender)
          }
        })
      }

      // Handle incoming tracks
      peerConnection.ontrack = (event) => {
        console.log(`Received ${event.track.kind} track from ${userId}`)

        const [remoteStream] = event.streams

        setRemoteStreams((prev) => ({
          ...prev,
          [userId]: remoteStream,
        }))

        // Set the stream for video element immediately
        if (remoteVideosRef.current[userId]) {
          remoteVideosRef.current[userId].srcObject = remoteStream
          // audio is not muted for remote streams
          remoteVideosRef.current[userId].muted = false
          remoteVideosRef.current[userId].volume = 1.0
        }

        // Handle track state changes
        event.track.onmute = () => {
          console.log(`Track ${event.track.kind} muted from ${userId}`)
          setRemoteUserStates((prev) => ({
            ...prev,
            [userId]: {
              ...prev[userId],
              [event.track.kind]: false,
            },
          }))
        }

        event.track.onunmute = () => {
          console.log(`Track ${event.track.kind} unmuted from ${userId}`)
          setRemoteUserStates((prev) => ({
            ...prev,
            [userId]: {
              ...prev[userId],
              [event.track.kind]: true,
            },
          }))
        }
      }

      // ICE candidate handling
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          console.log(`Sending ICE candidate to ${userId}`)
          socket.emit("BE-webrtc-ice-candidate", {
            to: userId,
            candidate: event.candidate,
            callId: call.callId,
          })
        }
      }

      peerConnection.oniceconnectionstatechange = () => {
        console.log(`ICE connection state for ${userId}: ${peerConnection.iceConnectionState}`)
        if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
          console.log(`Successfully connected to ${userId}`)
        } else if (
          peerConnection.iceConnectionState === "failed" ||
          peerConnection.iceConnectionState === "disconnected"
        ) {
          console.warn(`ICE connection with ${userId} is ${peerConnection.iceConnectionState}`)
        }
      }

      // Create and send offer if we're the caller
      if (call.caller.id === user.id || call.isGroupCall) {
        try {
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: call.callType === "video",
          })

          await peerConnection.setLocalDescription(offer)
          console.log(`Sending offer to ${userId}`)

          socket.emit("BE-webrtc-offer", {
            to: userId,
            offer: offer,
            callId: call.callId,
          })
        } catch (error) {
          console.error("Error creating offer:", error)
        }
      }

      return peerConnection
    } catch (error) {
      console.error(`Error creating peer connection for ${userId}:`, error)
    }
  }

  const handleOffer = async (userId, offer) => {
    try {
      console.log(`Handling offer from ${userId}`)

      let peerConnection = peerConnectionsRef.current[userId]?.connection

      if (!peerConnection) {
        peerConnection = await createPeerConnection(userId)
      }

      if (!peerConnection) {
        console.error(`Failed to create peer connection for ${userId}`)
        return
      }

      const rtcOffer = new RTCSessionDescription(offer)

      // Set remote description
      await peerConnection.setRemoteDescription(rtcOffer)
      peerConnectionsRef.current[userId].remoteDescriptionSet = true

      // Process any queued ICE candidates
      const iceCandidateQueue = peerConnectionsRef.current[userId].iceCandidateQueue || []
      while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift()
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
        } catch (error) {
          console.error("Error adding ICE candidate:", error)
        }
      }

      // Create and send answer
      const answer = await peerConnection.createAnswer()
      await peerConnection.setLocalDescription(answer)

      socket.emit("BE-webrtc-answer", {
        to: userId,
        answer: answer,
        callId: call.callId,
      })
    } catch (error) {
      console.error(`Error handling offer from ${userId}:`, error)
    }
  }

  const handleAnswer = async (userId, answer) => {
    try {
      console.log(`Handling answer from ${userId}`)

      const peerConnection = peerConnectionsRef.current[userId]?.connection

      if (!peerConnection) {
        console.error(`No peer connection found for ${userId}`)
        return
      }

      const rtcAnswer = new RTCSessionDescription(answer)
      await peerConnection.setRemoteDescription(rtcAnswer)
      peerConnectionsRef.current[userId].remoteDescriptionSet = true

      // Process any queued ICE candidates
      const iceCandidateQueue = peerConnectionsRef.current[userId].iceCandidateQueue || []
      while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift()
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
        } catch (error) {
          console.error("Error adding ICE candidate:", error)
        }
      }
    } catch (error) {
      console.error(`Error handling answer from ${userId}:`, error)
    }
  }

  const handleIceCandidate = async (userId, candidate) => {
    try {
      console.log(`Handling ICE candidate from ${userId}`)

      const peerData = peerConnectionsRef.current[userId]

      if (!peerData) {
        console.error(`No peer data found for ${userId}`)
        return
      }

      const peerConnection = peerData.connection

      if (peerData.remoteDescriptionSet) {
        // If remote description is set, add the candidate immediately
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
        } catch (error) {
          console.error("Error adding ICE candidate:", error)
        }
      } else {
        // Otherwise, queue the candidate for later
        peerData.iceCandidateQueue.push(candidate)
      }
    } catch (error) {
      console.error(`Error handling ICE candidate from ${userId}:`, error)
    }
  }

  // mute functionality
  const toggleAudio = () => {
    if (!localStreamRef.current) return

    const newAudioState = !isAudioEnabled
    console.log(`Toggling audio to ${newAudioState ? "unmuted" : "muted"}`)

    try {
      // Method 1: Toggle audio tracks in local stream
      const audioTracks = localStreamRef.current.getAudioTracks()
      audioTracks.forEach((track) => {
        track.enabled = newAudioState
        console.log(`Set local audio track.enabled = ${track.enabled}`)
      })

      //silent audio track if muting
      Object.keys(peerConnectionsRef.current).forEach((userId) => {
        const senders = audioSendersRef.current[userId]
        if (senders && senders.length > 0) {
          senders.forEach((sender) => {
            const track = sender.track
            if (track) {
              track.enabled = newAudioState
              console.log(`Set sender track.enabled = ${track.enabled} for user ${userId}`)
            }
          })
        }
      })

      // Update state
      setIsAudioEnabled(newAudioState)

      // Notify remote users about audio state change
      Object.keys(peerConnectionsRef.current).forEach((userId) => {
        console.log(`Sending track state change to ${userId}: audio = ${newAudioState}`)
        socket.emit("BE-track-state-changed", {
          to: userId,
          trackType: "audio",
          enabled: newAudioState,
          callId: call.callId,
        })
      })

      console.log(`Audio ${newAudioState ? "unmuted" : "muted"} successfully`)
    } catch (error) {
      console.error("Error toggling audio:", error)
    }
  }

  const toggleVideo = () => {
    if (localStreamRef.current && call.callType === "video") {
      const videoTracks = localStreamRef.current.getVideoTracks()
      const newVideoState = !isVideoEnabled

      videoTracks.forEach((track) => {
        track.enabled = newVideoState
        console.log(`Video track ${newVideoState ? "enabled" : "disabled"}`)
      })

      setIsVideoEnabled(newVideoState)

      // Notify remote users about video state change
      Object.keys(peerConnectionsRef.current).forEach((userId) => {
        socket.emit("BE-track-state-changed", {
          to: userId,
          trackType: "video",
          enabled: newVideoState,
          callId: call.callId,
        })
      })

      console.log(`Video ${newVideoState ? "enabled" : "disabled"}`)
    }
  }

  const cleanup = () => {
    // Stop all tracks in the local stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop()
        console.log(`Stopped ${track.kind} track`)
      })
    }

    // Close all peer connections
    Object.values(peerConnectionsRef.current).forEach((peer) => {
      if (peer.connection) {
        peer.connection.close()
      }
    })

    // Clear references
    peerConnectionsRef.current = {}
    audioSendersRef.current = {}
    localStreamRef.current = null
  }

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  // remote video rendering with mute handling
  const renderRemoteVideos = () => {
    return Object.keys(remoteStreams).map((userId) => {
      const userState = remoteUserStates[userId] || { audio: true, video: true }
      const userName = connectedUsers.find((u) => u.id === userId)?.name || "User"

      return (
        <div key={userId} className="relative rounded-lg overflow-hidden bg-gray-800">
          <video
            ref={(el) => {
              if (el) {
                remoteVideosRef.current[userId] = el
                if (remoteStreams[userId]) {
                  el.srcObject = remoteStreams[userId]

                  // audio is properly set based on mute state
                  el.muted = false
                  el.volume = 1.0

                  // Apply audio state from remote user
                  if (remoteStreams[userId].getAudioTracks().length > 0) {
                    remoteStreams[userId].getAudioTracks().forEach((track) => {
                      track.enabled = userState.audio
                      console.log(`Set remote audio track.enabled = ${track.enabled} for ${userId}`)
                    })
                  }

                  // Auto play the video
                  el.play().catch((error) => {
                    console.error("Error auto-playing video:", error)
                    // Try again with user interaction
                    document.addEventListener(
                      "click",
                      () => {
                        el.play().catch(console.error)
                      },
                      { once: true },
                    )
                  })
                }
              }
            }}
            autoPlay
            playsInline
            className={`w-full h-full object-cover ${call.callType === "audio" || !userState.video ? "hidden" : ""}`}
          />
          {(call.callType === "audio" || !userState.video) && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
              <div className="w-20 h-20 bg-blue-500 text-white rounded-full flex items-center justify-center text-2xl font-bold">
                {userName.charAt(0).toUpperCase()}
              </div>
            </div>
          )}
          <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded">
            {userName} {!userState.audio && "(Muted)"}
          </div>
          {!userState.video && call.callType === "video" && (
            <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
          )}
        </div>
      )
    })
  }

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
          <p className="text-sm text-gray-300">{formatDuration(callDuration)}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm bg-green-500 px-2 py-1 rounded">Connected</span>
          <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Call content */}
      <div className="flex-1 p-4 flex flex-col">
        {/* Video grid */}
        <div
          className={`flex-1 grid gap-4 ${Object.keys(remoteStreams).length > 0 ? "grid-cols-1 md:grid-cols-2" : ""}`}
        >
          {/* Remote videos */}
          {renderRemoteVideos()}

          {/* Local video */}
          <div
            className={`relative rounded-lg overflow-hidden bg-gray-800 ${Object.keys(remoteStreams).length > 0 ? "md:col-span-1" : "w-full h-full"}`}
          >
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${call.callType === "audio" || !isVideoEnabled ? "hidden" : ""}`}
            />
            {(call.callType === "audio" || !isVideoEnabled) && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                <div className="w-20 h-20 bg-blue-500 text-white rounded-full flex items-center justify-center text-2xl font-bold">
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
