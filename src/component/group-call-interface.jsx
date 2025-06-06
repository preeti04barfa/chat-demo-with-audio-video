import { useEffect, useRef, useState, useCallback } from "react";
import {
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Users,
  AlertCircle,
  UserPlus,
  X,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import * as mediasoupClient from "mediasoup-client";

export function GroupCallInterface({ call, user, socket, onEndCall }) {
  console.log(user, "user");

  const localVideoRef = useRef(null);
  const remoteVideosRef = useRef({});
  const localStreamRef = useRef(null);

  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef({});
  const consumersRef = useRef({});
  const remoteStreamsRef = useRef({});
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const connectionCheckIntervalRef = useRef(null);

  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(call.callType === "video");
  const [connectedUsers, setConnectedUsers] = useState([]);
  console.log(connectedUsers, "connectedUsers");

  const [callDuration, setCallDuration] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [permissionError, setPermissionError] = useState(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [sfuReady, setSfuReady] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [transportStates, setTransportStates] = useState({
    send: "disconnected",
    recv: "disconnected",
  });
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [networkQuality, setNetworkQuality] = useState("unknown");
  const [showDebugInfo, setShowDebugInfo] = useState(false);

  const logDebug = useCallback((message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    console.log(`[check-----SFU ${timestamp}] ${message}`, data || "");
  }, []);

  useEffect(() => {
    setConnectedUsers([
      {
        id: user.id,
        name: user.name,
        isLocal: true,
        joinedAt: new Date(),
        connectionState: "connecting",
      },
    ]);

    initializeMedia();

    const timer = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);

    startConnectionMonitoring();

    return () => {
      clearInterval(timer);
      stopConnectionMonitoring();
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (mediaReady && !sfuReady) {
      initializeSFU();
    }
  }, [mediaReady, sfuReady]);

  useEffect(() => {
    if (!socket) return;

    socket.on("FE-sfu-router-capabilities", handleRouterCapabilities);
    socket.on("FE-sfu-transport-created", handleTransportCreated);
    socket.on("FE-sfu-transport-connected", handleTransportConnected);
    socket.on("FE-sfu-producer-created", handleProducerCreated);
    socket.on("FE-sfu-new-producer", handleNewProducer);
    socket.on("FE-sfu-consumer-created", handleConsumerCreated);
    socket.on("FE-sfu-consumer-resumed", handleConsumerResumed);
    socket.on("FE-sfu-existing-producers", handleExistingProducers);
    socket.on("FE-sfu-participant-joined", handleParticipantJoined);
    socket.on("FE-user-joined-call", handleUserJoinedCall);
    socket.on("FE-user-left-call", handleUserLeftCall);
    socket.on("FE-existing-participants", handleExistingParticipants);
    socket.on("FE-error", handleSocketError);
    socket.on("connect", handleSocketReconnect);
    socket.on("disconnect", handleSocketDisconnect);

    socket.emit("BE-get-call-participants", { callId: call.callId });

    return () => {
      socket.off("FE-sfu-router-capabilities");
      socket.off("FE-sfu-transport-created");
      socket.off("FE-sfu-transport-connected");
      socket.off("FE-sfu-producer-created");
      socket.off("FE-sfu-new-producer");
      socket.off("FE-sfu-consumer-created");
      socket.off("FE-sfu-consumer-resumed");
      socket.off("FE-sfu-existing-producers");
      socket.off("FE-sfu-participant-joined");
      socket.off("FE-user-joined-call");
      socket.off("FE-user-left-call");
      socket.off("FE-existing-participants");
      socket.off("FE-error");
      socket.off("connect");
      socket.off("disconnect");
    };
  }, [socket]);

  const startConnectionMonitoring = () => {
    connectionCheckIntervalRef.current = setInterval(() => {
      checkConnectionQuality();
    }, 5000);
  };

  const stopConnectionMonitoring = () => {
    if (connectionCheckIntervalRef.current) {
      clearInterval(connectionCheckIntervalRef.current);
      connectionCheckIntervalRef.current = null;
    }
  };

  const checkConnectionQuality = async () => {
    try {
      if (
        sendTransportRef.current &&
        recvTransportRef.current &&
        transportStates.send === "connected" &&
        transportStates.recv === "connected"
      ) {
        const sendStats = await sendTransportRef.current.getStats();
        const recvStats = await recvTransportRef.current.getStats();

        let quality = "good";
        let rtt = 0;
        let packetLoss = 0;
        let statsAvailable = false;

        sendStats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded") {
            rtt = report.currentRoundTripTime * 1000 || 0;
            statsAvailable = true;
          }
          if (report.type === "outbound-rtp") {
            const packetsLost = report.packetsLost || 0;
            const packetsSent = report.packetsSent || 1;
            packetLoss = (packetsLost / packetsSent) * 100;
            statsAvailable = true;
          }
        });

        if (!statsAvailable) {
          setNetworkQuality("unknown");
          logDebug("Network quality: unknown (stats unavailable)");
          return;
        }

        if (rtt > 300 || packetLoss > 5) {
          quality = "poor";
        } else if (rtt > 150 || packetLoss > 2) {
          quality = "fair";
        }

        setNetworkQuality(quality);
        logDebug(`Network quality: ${quality}, RTT: ${rtt}ms, Packet loss: ${packetLoss}%`);
      } else {
        setNetworkQuality("unknown");
        logDebug("Network quality: unknown (transports not connected)");
      }
    } catch (error) {
      logDebug("Error checking connection quality:", error);
      setNetworkQuality("unknown");
    }
  };

  const handleSocketReconnect = () => {
    logDebug("Socket reconnected, rejoining SFU room");
    if (mediaReady) {
      socket.emit("BE-join-sfu-room", { callId: call.callId });
    }
  };

  const handleSocketDisconnect = () => {
    logDebug("Socket disconnected");
    setConnectionStatus("disconnected");
    forceReconnect();
  };

  const handleExistingParticipants = ({ participants }) => {
    logDebug("Received existing participants:", participants);

    const allParticipants = [
      {
        id: user.id,
        name: user.name,
        isLocal: true,
        joinedAt: new Date(),
        connectionState:
          transportStates.send === "connected" && transportStates.recv === "connected" ? "connected" : "connecting",
      },
      ...participants
        .filter((p) => p.userId !== user.id)
        .map((p) => ({
          id: p.userId,
          name: p.userInfo?.name || `User ${p.userId}`,
          isLocal: false,
          joinedAt: new Date(p.joinedAt),
          connectionState: "connecting",
        })),
    ];

    setConnectedUsers(allParticipants);
  };

  const handleSocketError = ({ message }) => {
    setPermissionError(`Connection error: ${message}`);
  };

  const initializeMedia = async () => {
    try {
      setConnectionStatus("requesting-media");
      setPermissionError(null);

      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
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
      };

      logDebug("Requesting media with constraints:", constraints);

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      logDebug("Media access granted successfully");
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        localVideoRef.current.playsInline = true;
        localVideoRef.current.autoplay = true;
      }

      setMediaReady(true);
      setConnectionStatus("media-ready");
    } catch (error) {
      logDebug("Error getting user media:", error);

      if (call.callType === "video") {
        try {
          logDebug("Video failed, trying audio-only fallback");
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });

          localStreamRef.current = audioStream;
          setIsVideoEnabled(false);
          setMediaReady(true);
          setConnectionStatus("media-ready");

          logDebug("Audio-only fallback successful");
          return;
        } catch (audioError) {
          logDebug("Audio fallback also failed:", audioError);
        }
      }

      let errorMessage = "Could not access camera/microphone. Please check your permissions and try again.";

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorMessage = "Permission denied. Please allow access to your camera/microphone and refresh the page.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorMessage = "No camera or microphone found. Please connect a device and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorMessage = "Your camera or microphone is already in use by another application.";
      } else if (error.name === "OverconstrainedError") {
        errorMessage = "The requested media settings are not supported by your device.";
      }

      setPermissionError(errorMessage);
    }
  };

  const initializeSFU = async () => {
    try {
      logDebug("Initializing Simple SFU");
      setConnectionStatus("connecting-sfu");
      setIsReconnecting(false);
      reconnectAttemptsRef.current = 0;

      socket.emit("BE-join-sfu-room", { callId: call.callId });

      logDebug("SFU room join request sent");
    } catch (error) {
      logDebug("Error initializing SFU:", error);
      setPermissionError("Failed to initialize group call. Please try again.");
    }
  };

  const handleRouterCapabilities = async ({ callId, rtpCapabilities }) => {
    try {
      logDebug("Received router RTP capabilities for call:", callId);

      if (callId !== call.callId) {
        logDebug("Received capabilities for different call, ignoring");
        return;
      }

      if (!rtpCapabilities) {
        throw new Error("Invalid RTP capabilities received");
      }

      setConnectionStatus("creating-device");

      deviceRef.current = new mediasoupClient.Device();
      await deviceRef.current.load({ routerRtpCapabilities: rtpCapabilities });

      logDebug("Mediasoup device loaded successfully");
      setSfuReady(true);
      setConnectionStatus("device-ready");

      logDebug("Creating send transport");
      socket.emit("BE-sfu-create-transport", {
        callId: call.callId,
        direction: "send",
      });
    } catch (error) {
      logDebug("Error handling router RTP capabilities:", error);
      setPermissionError(`Failed to setup media connection: ${error.message}`);
    }
  };

  const handleTransportCreated = async ({ callId, direction, transportOptions }) => {
    try {
      if (callId !== call.callId) {
        logDebug("Transport created for different call, ignoring");
        return;
      }

      logDebug(`Transport created: ${direction}`, transportOptions);
      setConnectionStatus(`transport-${direction}-created`);

      const iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ];

      if (direction === "send") {
        const enhancedOptions = {
          ...transportOptions,
          iceServers,
          iceTransportPolicy: "relay", // Force TURN usage for testing
          iceCandidatePoolSize: 10,
          bundlePolicy: "balanced",
          rtcpMuxPolicy: "require",
        };

        sendTransportRef.current = deviceRef.current.createSendTransport(enhancedOptions);

        sendTransportRef.current.on("connect", async ({ dtlsParameters }, callback, errback) => {
          try {
            logDebug("Connecting send transport with DTLS parameters");
            socket.emit("BE-sfu-connect-transport", {
              transportId: transportOptions.id,
              dtlsParameters,
            });

            let isResolved = false;
            const handleConnected = ({ transportId }) => {
              if (transportId === transportOptions.id && !isResolved) {
                isResolved = true;
                socket.off("FE-sfu-transport-connected", handleConnected);
                logDebug("Send transport connected successfully");
                setTransportStates((prev) => ({ ...prev, send: "connected" }));
                callback();
              }
            };
            socket.on("FE-sfu-transport-connected", handleConnected);

            setTimeout(() => {
              if (!isResolved) {
                isResolved = true;
                socket.off("FE-sfu-transport-connected", handleConnected);
                logDebug("Send transport connection timeout");
                errback(new Error("Send transport connection timeout"));
              }
            }, 30000);
          } catch (error) {
            logDebug("Error in send transport connect:", error);
            errback(error);
          }
        });

        sendTransportRef.current.on("produce", async ({ kind, rtpParameters }, callback, errback) => {
          try {
            logDebug(`Producing ${kind}`);
            socket.emit("BE-sfu-produce", {
              transportId: transportOptions.id,
              kind,
              rtpParameters,
            });

            let isResolved = false;
            const handleProducerCreated = ({ producerId, kind: responseKind }) => {
              if (responseKind === kind && !isResolved) {
                isResolved = true;
                socket.off("FE-sfu-producer-created", handleProducerCreated);
                logDebug(`Producer created successfully: ${kind} (${producerId})`);
                callback({ id: producerId });
              }
            };
            socket.on("FE-sfu-producer-created", handleProducerCreated);

            setTimeout(() => {
              if (!isResolved) {
                isResolved = true;
                socket.off("FE-sfu-producer-created", handleProducerCreated);
                logDebug(`Producer creation timeout for ${kind}`);
                errback(new Error(`Producer creation timeout for ${kind}`));
              }
            }, 20000);
          } catch (error) {
            logDebug(`Error in produce for ${kind}:`, error);
            errback(error);
          }
        });

        sendTransportRef.current.on("connectionstatechange", (state) => {
          logDebug(`Send transport connection state: ${state}`);
          setTransportStates((prev) => ({ ...prev, send: state }));

          if (state === "connected") {
            setConnectionStatus("send-transport-connected");
            updateUserConnectionState();
            startProducing(); // Start producing only when connected
            // Create receive transport immediately
            logDebug("Creating receive transport");
            socket.emit("BE-sfu-create-transport", {
              callId: call.callId,
              direction: "recv",
            });
          } else if (state === "failed" || state === "disconnected") {
            setConnectionStatus("send-transport-failed");
            handleTransportFailure("send");
          }
        });
      } else if (direction === "recv") {
        const enhancedOptions = {
          ...transportOptions,
          iceServers,
          iceTransportPolicy: "relay", // Force TURN usage for testing
          iceCandidatePoolSize: 10,
          bundlePolicy: "balanced",
          rtcpMuxPolicy: "require",
        };

        recvTransportRef.current = deviceRef.current.createRecvTransport(enhancedOptions);

        recvTransportRef.current.on("connect", async ({ dtlsParameters }, callback, errback) => {
          try {
            logDebug("Connecting receive transport with DTLS parameters");
            socket.emit("BE-sfu-connect-transport", {
              transportId: transportOptions.id,
              dtlsParameters,
            });

            let isResolved = false;
            const handleConnected = ({ transportId }) => {
              if (transportId === transportOptions.id && !isResolved) {
                isResolved = true;
                socket.off("FE-sfu-transport-connected", handleConnected);
                logDebug("Receive transport connected successfully");
                setTransportStates((prev) => ({ ...prev, recv: "connected" }));
                callback();
              }
            };
            socket.on("FE-sfu-transport-connected", handleConnected);

            setTimeout(() => {
              if (!isResolved) {
                isResolved = true;
                socket.off("FE-sfu-transport-connected", handleConnected);
                logDebug("Receive transport connection timeout");
                errback(new Error("Receive transport connection timeout"));
              }
            }, 30000);
          } catch (error) {
            logDebug("Error in receive transport connect:", error);
            errback(error);
          }
        });

        recvTransportRef.current.on("connectionstatechange", (state) => {
          logDebug(`Receive transport connection state: ${state}`);
          setTransportStates((prev) => ({ ...prev, recv: state }));

          if (state === "connected") {
            setConnectionStatus("connected");
            updateUserConnectionState();
            setIsReconnecting(false);
            reconnectAttemptsRef.current = 0;
          } else if (state === "failed" || state === "disconnected") {
            setConnectionStatus("recv-transport-failed");
            handleTransportFailure("recv");
          }
        });

        logDebug("Receive transport created, requesting existing producers");

        setTimeout(() => {
          socket.emit("BE-get-existing-producers", { callId: call.callId });
        }, 3000);
      }
    } catch (error) {
      logDebug("Error handling transport creation:", error);
      setPermissionError(`Failed to create media transport: ${error.message}`);
    }
  };

  const handleTransportFailure = (transportType) => {
    logDebug(`${transportType} transport failed, attempting reconnection`);

    if (isReconnecting) return;

    setIsReconnecting(true);

    reconnectAttemptsRef.current += 1;

    if (reconnectAttemptsRef.current > 3) {
      logDebug("Switching to full reconnection after multiple transport failures");
      forceReconnect();
      return;
    }

    const delay = Math.min(3000 * Math.pow(2, reconnectAttemptsRef.current - 1), 48000);

    logDebug(`Scheduling reconnection attempt ${reconnectAttemptsRef.current} in ${delay}ms`);

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    reconnectTimeoutRef.current = setTimeout(() => {
      logDebug("Attempting transport reconnection");

      if (transportType === "recv" && recvTransportRef.current) {
        recvTransportRef.current.close();
        recvTransportRef.current = null;
      } else if (transportType === "send" && sendTransportRef.current) {
        sendTransportRef.current.close();
        sendTransportRef.current = null;
      }

      setTransportStates((prev) => ({ ...prev, [transportType]: "disconnected" }));

      socket.emit("BE-sfu-create-transport", {
        callId: call.callId,
        direction: transportType,
      });
    }, delay);
  };

  const updateUserConnectionState = () => {
    const isConnected = transportStates.send === "connected" && transportStates.recv === "connected";

    setConnectedUsers((prev) =>
      prev.map((user) =>
        user.isLocal ? { ...user, connectionState: isConnected ? "connected" : "connecting" } : user
      )
    );

    if (isConnected) {
      setConnectionStatus("connected");
      setIsReconnecting(false);
    }
  };

  const startProducing = async () => {
    try {
      if (!localStreamRef.current || !sendTransportRef.current) {
        logDebug("Cannot start producing - missing stream or transport");
        return;
      }

      const tracks = localStreamRef.current.getTracks();
      logDebug(`Starting to produce ${tracks.length} tracks`);

      for (const track of tracks) {
        if (track.kind === "audio" && isAudioEnabled) {
          try {
            logDebug("Creating audio producer");
            const producer = await sendTransportRef.current.produce({
              track,
              codecOptions: {
                opusStereo: false,
                opusFec: true,
                opusDtx: true,
              },
            });
            producersRef.current.audio = producer;
            logDebug("Audio producer created successfully", producer.id);

            producer.on("trackended", () => {
              logDebug("Audio track ended");
            });

            producer.on("transportclose", () => {
              logDebug("Audio producer transport closed");
            });
          } catch (error) {
            logDebug("Error creating audio producer:", error);
          }
        } else if (track.kind === "video" && isVideoEnabled && call.callType === "video") {
          try {
            logDebug("Creating video producer");
            const producer = await sendTransportRef.current.produce({
              track,
              encodings: [{ maxBitrate: 500000 }],
            });
            producersRef.current.video = producer;
            logDebug("Video producer created successfully", producer.id);

            producer.on("trackended", () => {
              logDebug("Video track ended");
            });

            producer.on("transportclose", () => {
              logDebug("Video producer transport closed");
            });
          } catch (error) {
            logDebug("Error creating video producer:", error);
          }
        }
      }
    } catch (error) {
      logDebug("Error starting production:", error);
    }
  };

  const handleTransportConnected = ({ transportId }) => {
    logDebug(`Transport connected: ${transportId}`);
  };

  const handleProducerCreated = ({ producerId, kind }) => {
    logDebug(`Producer created: ${kind} (${producerId})`);

    setTimeout(() => {
      updateUserConnectionState();
    }, 1000);
  };

  const handleNewProducer = async ({ producerId, participantId, kind }) => {
    try {
      if (participantId === user.id) {
        logDebug("Ignoring own producer");
        return;
      }

      logDebug(`New producer available: ${kind} (${producerId}) from participant ${participantId}`);

      if (!recvTransportRef.current || !deviceRef.current) {
        logDebug("Receive transport not ready, skipping consumption");
        return;
      }

      setTimeout(() => {
        if (recvTransportRef.current && deviceRef.current) {
          logDebug("Creating consumer for new producer");
          socket.emit("BE-sfu-consume", {
            transportId: recvTransportRef.current.id,
            producerId,
            rtpCapabilities: deviceRef.current.rtpCapabilities,
          });
        }
      }, 2000);
    } catch (error) {
      logDebug("Error handling new producer:", error);
    }
  };

  const handleConsumerCreated = async ({ consumerData }) => {
    try {
      logDebug(`Consumer created:`, consumerData);

      if (!recvTransportRef.current) {
        logDebug("Receive transport not available for consumer creation");
        return;
      }

      const consumer = await recvTransportRef.current.consume({
        id: consumerData.id,
        producerId: consumerData.producerId,
        kind: consumerData.kind,
        rtpParameters: consumerData.rtpParameters,
      });

      consumersRef.current[consumerData.id] = consumer;

      const participantId = consumerData.producerParticipantId;
      logDebug(`Consumer created for ${consumerData.kind} from participant ${participantId}`);

      consumer.on("trackended", () => {
        logDebug(`Consumer track ended for participant ${participantId}`);
      });

      consumer.on("transportclose", () => {
        logDebug(`Consumer transport closed for participant ${participantId}`);
      });

      consumer.on("producerclose", () => {
        logDebug(`Consumer producer closed for participant ${participantId}`);
      });

      if (!remoteStreamsRef.current[participantId]) {
        remoteStreamsRef.current[participantId] = new MediaStream();
        logDebug(`Created new remote stream for participant ${participantId}`);
      }

      const remoteStream = remoteStreamsRef.current[participantId];
      const existingTrack = remoteStream.getTracks().find((track) => track.kind === consumer.track.kind);

      if (existingTrack) {
        remoteStream.removeTrack(existingTrack);
        logDebug(`Replaced existing ${consumer.track.kind} track for participant ${participantId}`);
      }

      remoteStream.addTrack(consumer.track);
      logDebug(`Added ${consumer.track.kind} track to remote stream for participant ${participantId}`);

      setConnectedUsers((prev) => {
        const existing = prev.find((u) => u.id === participantId);
        if (!existing) {
          return [
            ...prev,
            {
              id: participantId,
              name: `User ${participantId}`,
              isLocal: false,
              joinedAt: new Date(),
              connectionState: "connected",
            },
          ];
        } else {
          return prev.map((u) => (u.id === participantId ? { ...u, connectionState: "connected" } : u));
        }
      });

      logDebug("Resuming consumer");
      socket.emit("BE-sfu-resume-consumer", { consumerId: consumerData.id });

      setTimeout(() => {
        setConnectedUsers((prev) => [...prev]);
      }, 100);
    } catch (error) {
      logDebug("Error handling consumer creation:", error);
    }
  };

  const handleConsumerResumed = ({ consumerId }) => {
    logDebug(`Consumer resumed: ${consumerId}`);

    const consumer = consumersRef.current[consumerId];
    if (consumer && consumer.track) {
      logDebug(`Consumer track ready: ${consumer.track.kind} - enabled: ${consumer.track.enabled}`);

      consumer.track.enabled = true;

      setTimeout(() => {
        setConnectedUsers((prev) => [...prev]);
      }, 100);
    }
  };

  const handleExistingProducers = async ({ callId, producers }) => {
    try {
      if (callId !== call.callId) {
        logDebug("Existing producers for different call, ignoring");
        return;
      }

      logDebug(`Received existing producers:`, producers);

      for (let i = 0; i < producers.length; i++) {
        const producer = producers[i];
        if (producer.participantId !== user.id) {
          setTimeout(() => {
            handleNewProducer({
              producerId: producer.id,
              participantId: producer.participantId,
              kind: producer.kind,
            });
          }, i * 1000);
        }
      }
    } catch (error) {
      logDebug("Error handling existing producers:", error);
    }
  };

  const handleParticipantJoined = ({ participantId, participantInfo }) => {
    logDebug(`Participant joined: ${participantId}`, participantInfo);

    setConnectedUsers((prev) => {
      if (prev.some((u) => u.id === participantId)) {
        return prev;
      }
      return [
        ...prev,
        {
          id: participantId,
          name: participantInfo?.name || `User ${participantId}`,
          isLocal: false,
          joinedAt: new Date(),
          connectionState: "connecting",
        },
      ];
    });
  };

  const handleUserJoinedCall = ({ userId, userInfo }) => {
    logDebug(`User joined call: ${userId}`, userInfo);

    setConnectedUsers((prev) => {
      if (prev.some((u) => u.id === userId)) {
        return prev.map((u) =>
          u.id === userId ? { ...u, name: userInfo?.name || u.name, connectionState: "connecting" } : u
        );
      }
      return [
        ...prev,
        {
          id: userId,
          name: userInfo?.name || `User ${userId}`,
          isLocal: false,
          joinedAt: new Date(),
          connectionState: "connecting",
        },
      ];
    });
  };

  const handleUserLeftCall = ({ userId }) => {
    logDebug(`User left call: ${userId}`);

    setConnectedUsers((prev) => prev.filter((u) => u.id !== userId));

    if (remoteStreamsRef.current[userId]) {
      remoteStreamsRef.current[userId].getTracks().forEach((track) => track.stop());
      delete remoteStreamsRef.current[userId];
    }

    Object.entries(consumersRef.current).forEach(([consumerId, consumer]) => {
      if (consumer.appData?.participantId === userId) {
        consumer.close();
        delete consumersRef.current[consumerId];
      }
    });
  };

  const toggleAudio = async () => {
    if (!localStreamRef.current) return;

    const newAudioState = !isAudioEnabled;

    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = newAudioState;
    });

    if (producersRef.current.audio) {
      if (newAudioState) {
        await producersRef.current.audio.resume();
      } else {
        await producersRef.current.audio.pause();
      }
    }

    setIsAudioEnabled(newAudioState);
  };

  const toggleVideo = async () => {
    if (!localStreamRef.current || call.callType !== "video") return;

    const newVideoState = !isVideoEnabled;

    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = newVideoState;
    });

    if (producersRef.current.video) {
      if (newVideoState) {
        await producersRef.current.video.resume();
      } else {
        await producersRef.current.video.pause();
      }
    }

    setIsVideoEnabled(newVideoState);
  };

  const retryMediaAccess = async () => {
    setPermissionError(null);
    setMediaReady(false);
    setSfuReady(false);
    setConnectionStatus("connecting");
    setIsReconnecting(false);
    reconnectAttemptsRef.current = 0;

    cleanup();

    await initializeMedia();
  };

  const forceReconnect = async () => {
    logDebug("Forcing complete reconnection");
    setIsReconnecting(true);

    cleanup();

    setConnectionStatus("reconnecting");
    setTransportStates({
      send: "disconnected",
      recv: "disconnected",
    });
    reconnectAttemptsRef.current = 0;
    setMediaReady(false);
    setSfuReady(false);

    setTimeout(async () => {
      await initializeMedia();
    }, 2000);
  };

  const cleanup = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    Object.values(consumersRef.current).forEach((consumer) => {
      consumer.close();
    });

    Object.values(producersRef.current).forEach((producer) => {
      producer.close();
    });

    if (sendTransportRef.current) {
      sendTransportRef.current.close();
    }

    if (recvTransportRef.current) {
      recvTransportRef.current.close();
    }

    Object.values(remoteStreamsRef.current).forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });

    localStreamRef.current = null;
    deviceRef.current = null;
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    producersRef.current = {};
    consumersRef.current = {};
    remoteStreamsRef.current = {};

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopConnectionMonitoring();
  };

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const getNetworkQualityIcon = () => {
    switch (networkQuality) {
      case "good":
        return <Wifi className="w-4 h-4 text-green-500" />;
      case "fair":
        return <Wifi className="w-4 h-4 text-yellow-500" />;
      case "poor":
        return <WifiOff className="w-4 h-4 text-red-500" />;
      default:
        return <Wifi className="w-4 h-4 text-gray-500" />;
    }
  };

  const renderAllVideos = () => {
    const allStreams = [];
    console.log(allStreams, "allStreams");

    allStreams.push({
      userId: user.id,
      stream: localStreamRef.current,
      userInfo: user,
      isLocal: true,
      userState: { audio: isAudioEnabled, video: isVideoEnabled },
    });

    Object.entries(remoteStreamsRef.current).forEach(([userId, stream]) => {
      console.log(userId, "userId");

      if (userId !== user.id && stream && stream.getTracks().length > 0) {
        const userInfo = connectedUsers.find((u) => u.id === userId) || {
          name: "Unknown User",
          id: userId,
        };

        allStreams.push({
          userId,
          stream,
          userInfo,
          isLocal: false,
          userState: { audio: true, video: call.callType === "video" },
        });
      }
    });

    const totalParticipants = allStreams.length;
    let gridClass = "grid-cols-1";

    if (totalParticipants === 2) {
      gridClass = "grid-cols-1 md:grid-cols-2";
    } else if (totalParticipants <= 4) {
      gridClass = "grid-cols-2";
    } else if (totalParticipants <= 9) {
      gridClass = "grid-cols-3";
    } else if (totalParticipants <= 16) {
      gridClass = "grid-cols-4";
    } else {
      gridClass = "grid-cols-5";
    }

    return (
      <div className={`grid gap-2 ${gridClass} h-full`}>
        {allStreams.map(({ userId, stream, userInfo, isLocal, userState }) => (
          <div
            key={userId}
            className="relative rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center"
          >
            <video
              ref={(el) => {
                if (el && stream) {
                  try {
                    if (isLocal) {
                      if (localVideoRef.current !== el) {
                        localVideoRef.current = el;
                      }
                    } else {
                      remoteVideosRef.current[userId] = el;
                    }

                    if (el.srcObject !== stream) {
                      el.srcObject = stream;
                      el.muted = isLocal;
                      el.playsInline = true;
                      el.autoplay = true;

                      if (!isLocal) {
                        setTimeout(() => {
                          if (el && el.srcObject) {
                            el.play().catch((error) => {
                              logDebug("Remote video play failed:", error);
                              const retryPlay = () => {
                                if (el && el.srcObject) {
                                  el.play().catch(console.error);
                                }
                                document.removeEventListener("click", retryPlay);
                              };
                              document.addEventListener("click", retryPlay, { once: true });
                            });
                          }
                        }, 100);
                      }
                    }
                  } catch (error) {
                    console.error("Error setting up video element:", error);
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
                  {(userInfo?.name || "U").charAt(0).toUpperCase()}
                </div>
              </div>
            )}

            <div className="absolute bottom-2 left-2 text-white text-sm bg-black bg-opacity-50 px-2 py-1 rounded flex items-center">
              {isLocal ? "You" : userInfo?.name || "Unknown User"}
              {!userState.audio && <span className="ml-1">(Muted)</span>}
            </div>

            {!userState.video && call.callType === "video" && (
              <div className="absolute top-2 right-2 text-white text-xs bg-red-500 px-2 py-1 rounded">Video Off</div>
            )}

            <div
              className={`absolute top-2 left-2 w-3 h-3 rounded-full ${
                isLocal
                  ? connectionStatus === "connected"
                    ? "bg-green-500"
                    : connectionStatus.includes("failed")
                    ? "bg-red-500"
                    : "bg-yellow-500 animate-pulse"
                  : userInfo?.connectionState === "connected"
                  ? "bg-green-500"
                  : "bg-yellow-500 animate-pulse"
              }`}
              title={`Connection: ${isLocal ? connectionStatus : userInfo?.connectionState}`}
            />
          </div>
        ))}
      </div>
    );
  };

  const actualParticipantCount = connectedUsers.length;

  if (permissionError) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Group {call.callType} call</h2>
            <p className="text-sm text-gray-300">Connection failed</p>
          </div>
          <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="bg-gray-800 p-6 rounded-lg max-w-md w-full text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-white mb-2">Connection Error</h3>
            <p className="text-gray-300 mb-4">{permissionError}</p>
            <div className="flex flex-col gap-3">
              <button onClick={retryMediaAccess} className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded">
                Retry Connection
              </button>
              <button onClick={onEndCall} className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded">
                Leave Call
              </button>
            </div>
            <p className="text-gray-400 text-sm mt-4">Status: {connectionStatus}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!mediaReady || !sfuReady) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Group {call.callType} call</h2>
            <p className="text-sm text-gray-300">{connectionStatus}</p>
          </div>
          <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-white text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            <p className="text-lg">Setting up group call...</p>
            <p className="text-sm text-gray-300 mt-2">{connectionStatus}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-gray-900 relative">
      <div className="flex-1 flex flex-col">
        <div className="bg-gray-800 p-4 text-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Group {call.callType} call (Simple SFU)</h2>
            <p className="text-sm text-gray-300 flex items-center gap-2">
              {formatDuration(callDuration)} • {actualParticipantCount} participant
              {actualParticipantCount !== 1 ? "s" : ""} • {connectionStatus}
              {getNetworkQualityIcon()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(connectionStatus.includes("failed") || isReconnecting) && (
              <button
                onClick={forceReconnect}
                className="flex items-center gap-1 text-sm px-3 py-2 rounded bg-yellow-600 hover:bg-yellow-700 text-white"
                disabled={isReconnecting}
              >
                <RefreshCw className={`w-4 h-4 ${isReconnecting ? "animate-spin" : ""}`} />
                {isReconnecting ? "Reconnecting..." : "Reconnect"}
              </button>
            )}
            <button
              onClick={() => setShowParticipants(!showParticipants)}
              className={`flex items-center gap-1 text-sm px-3 py-2 rounded transition-colors ${
                showParticipants
                  ? "bg-blue-600 text-white"
                  : "text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600"
              }`}
            >
              <Users className="w-4 h-4" />
              {actualParticipantCount}
            </button>
            <button onClick={onEndCall} className="bg-red-500 text-white p-2 rounded-full hover:bg-red-600">
              <PhoneOff className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 p-2 overflow-hidden">{renderAllVideos()}</div>

        <div className="bg-gray-800 p-4 flex justify-center gap-4">
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

        <div className="bg-gray-900 border-t border-gray-700 p-2 text-xs text-gray-400">
          <button
            onClick={() => setShowDebugInfo(!showDebugInfo)}
            className="flex items-center gap-1 hover:text-gray-300 cursor-pointer"
          >
            <span>Connection Debug Info</span>
            <span className={`transform transition-transform ${showDebugInfo ? "rotate-180" : ""}`}>▼</span>
          </button>

          {showDebugInfo && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <p>
                  Send Transport:{" "}
                  <span className={transportStates.send === "connected" ? "text-green-400" : "text-yellow-400"}>
                    {transportStates.send}
                  </span>
                </p>
                <p>
                  Recv Transport:{" "}
                  <span className={transportStates.recv === "connected" ? "text-green-400" : "text-yellow-400"}>
                    {transportStates.recv}
                  </span>
                </p>
                <p>
                  Network Quality:{" "}
                  <span
                    className={
                      networkQuality === "good"
                        ? "text-green-400"
                        : networkQuality === "fair"
                        ? "text-yellow-400"
                        : "text-red-400"
                    }
                  >
                    {networkQuality}
                  </span>
                </p>
              </div>
              <div>
                <p>
                  Connection Status:{" "}
                  <span className={connectionStatus === "connected" ? "text-green-400" : "text-yellow-400"}>
                    {connectionStatus}
                  </span>
                </p>
                <p>
                  Reconnect Attempts: <span className="text-gray-300">{reconnectAttemptsRef.current}</span>
                </p>
                <p>
                  Is Reconnecting:{" "}
                  <span className={isReconnecting ? "text-yellow-400" : "text-green-400"}>
                    {isReconnecting ? "Yes" : "No"}
                  </span>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showParticipants && (
        <div className="w-80 bg-gray-800 border-l border-gray-700 flex flex-col">
          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <UserPlus className="w-4 h-4" />
              Participants ({actualParticipantCount})
            </h3>
            <button onClick={() => setShowParticipants(false)} className="text-gray-400 hover:text-white p-1 rounded">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <div className="space-y-3">
              {connectedUsers.map((participant) => (
                <div key={participant.id} className="flex items-center gap-3 bg-gray-700 p-3 rounded-lg">
                  <div className="w-10 h-10 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                    {participant.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{participant.name}</p>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      {participant.isLocal && <span>(You)</span>}
                      <div
                        className={`w-2 h-2 rounded-full ${
                          participant.connectionState === "connected" ? "bg-green-500" : "bg-yellow-500"
                        }`}
                      />
                      <span>{participant.connectionState === "connected" ? "Connected" : "Connecting..."}</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center ${
                        isAudioEnabled && participant.isLocal ? "bg-green-600" : "bg-gray-600"
                      }`}
                    >
                      {isAudioEnabled && participant.isLocal ? (
                        <Mic className="w-3 h-3 text-white" />
                      ) : (
                        <MicOff className="w-3 h-3 text-gray-400" />
                      )}
                    </div>
                    {call.callType === "video" && (
                      <div
                        className={`w-6 h-6 rounded-full flex items-center justify-center ${
                          isVideoEnabled && participant.isLocal ? "bg-green-600" : "bg-gray-600"
                        }`}
                      >
                        {isVideoEnabled && participant.isLocal ? (
                          <Video className="w-3 h-3 text-white" />
                        ) : (
                          <VideoOff className="w-3 h-3 text-gray-400" />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}