import { CallInterfaceP2P } from "./call-interface-p2p"
import { GroupCallInterface } from "./group-call-interface"

export function CallInterface({ call, user, socket, onEndCall }) {
  if (call.isGroupCall || call.groupId || call.usesMediasoup) {
    console.log("Routing to GroupCallInterface")
    return <GroupCallInterface call={call} user={user} socket={socket} onEndCall={onEndCall} />
  } else {
    console.log("Routing to CallInterfaceP2P")
    return <CallInterfaceP2P call={call} user={user} socket={socket} onEndCall={onEndCall} />
  }
}
