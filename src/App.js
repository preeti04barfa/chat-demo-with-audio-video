import { useState, useEffect } from "react"
import io from "socket.io-client"
import ChatApp from "./component/chat-app"

let socket
if (typeof window !== "undefined") {
  if (!socket) {
    socket = io(process.env.REACT_APP_SOCKET_URL || "https://jszf6p8r-3001.inc1.devtunnels.ms/", {
      transports: ["websocket"],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    })
  }
}

export default function App() {
  const [user, setUser] = useState(null)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [isConnected, setIsConnected] = useState(false)
  const [connectionError, setConnectionError] = useState("")
  const [isRegistering, setIsRegistering] = useState(false)
  const [registrationError, setRegistrationError] = useState("")

  useEffect(() => {
    if (!socket) return

    socket.on("connect", () => {
      console.log("Connected to server, socket ID:", socket.id)
      setIsConnected(true)
      setConnectionError("")
    })

    socket.on("disconnect", () => {
      console.log("Disconnected from server")
      setIsConnected(false)
    })

    socket.on("connect_error", (error) => {
      console.error("Connection error:", error)
      setConnectionError("Failed to connect to chat server. Please try again later.")
      setIsConnected(false)
    })

    socket.on("FE-registration-success", ({ user: userData, message }) => {
      console.log("Registration successful:", userData)
      setUser(userData)
      setIsRegistering(false)
      setRegistrationError("")
    })

    socket.on("FE-registration-error", ({ message }) => {
      console.error("Registration error:", message)
      setRegistrationError(message)
      setIsRegistering(false)
    })

    return () => {
      socket.off("connect")
      socket.off("disconnect")
      socket.off("connect_error")
      socket.off("FE-registration-success")
      socket.off("FE-registration-error")
    }
  }, [])

  const handleRegister = (e) => {
    e.preventDefault()
    if (!name.trim() || !email.trim()) {
      setRegistrationError("Please fill in all fields")
      return
    }

    setIsRegistering(true)
    setRegistrationError("")

    socket.emit("BE-register-user", {
      name: name.trim(),
      email: email.trim(),
    })
  }

  if (connectionError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Connection Error</h1>
          <p className="text-gray-700 mb-4">{connectionError}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-blue-500 text-white py-2 px-4 rounded hover:bg-blue-600"
          >
            Retry Connection
          </button>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full">
          <h1 className="text-3xl font-bold text-center mb-6">PreeTalk</h1>

          <div className="mb-4 text-center">
            <span className={`text-sm ${isConnected ? "text-green-600" : "text-gray-600"}`}>
              {isConnected ? "✓ Connected to server" : "Connecting to server..."}
            </span>
          </div>

          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                type="text"
                id="name"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isConnected || isRegistering}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                type="email"
                id="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!isConnected || isRegistering}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            {registrationError && <div className="text-red-600 text-sm">{registrationError}</div>}

            <button
              type="submit"
              disabled={!isConnected || isRegistering || !name.trim() || !email.trim()}
              className="w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {isRegistering ? "Joining..." : "Join Chat"}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return <ChatApp socket={socket} user={user} />
}

