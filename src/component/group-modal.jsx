"use client"

import { useState } from "react"

export function GroupModal({ users, onClose, onCreateGroup, isOpen, currentUser }) {
  const [groupName, setGroupName] = useState("")
  const [selectedUsers, setSelectedUsers] = useState({})
  const [error, setError] = useState("")

  if (!isOpen) return null

  const handleUserSelect = (userId) => {
    setSelectedUsers((prev) => ({
      ...prev,
      [userId]: !prev[userId],
    }))
  }

  const handleCreateGroup = () => {
    if (!groupName.trim()) {
      setError("Please enter a group name")
      return
    }

    const members = Object.keys(selectedUsers).filter((id) => selectedUsers[id])

    if (members.length === 0) {
      setError("Please select at least one user")
      return
    }

    onCreateGroup({
      name: groupName.trim(),
      members,
    })

    // Reset form
    setGroupName("")
    setSelectedUsers({})
    setError("")
  }

  // Filter out current user from the list
  const availableUsers = users ? users.filter((user) => user._id !== currentUser.id) : []

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Create New Group</h3>
          <button className="text-gray-500 hover:text-gray-700 text-xl" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="group-name" className="block text-sm font-medium text-gray-700 mb-1">
              Group Name
            </label>
            <input
              id="group-name"
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Enter group name"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && <div className="text-red-600 text-sm">{error}</div>}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Select Members</label>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {availableUsers && availableUsers.length > 0 ? (
                availableUsers.map((user) => (
                  <div key={user._id} className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id={`user-${user._id}`}
                      checked={!!selectedUsers[user._id]}
                      onChange={() => handleUserSelect(user._id)}
                      className="rounded"
                    />
                    <label htmlFor={`user-${user._id}`} className="flex items-center gap-3 cursor-pointer flex-1">
                      <div className="relative">
                        <div className="w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm font-semibold">
                          {user.name.charAt(0).toUpperCase()}
                        </div>
                        {/* Online/Offline Status Dot */}
                        <div
                          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-white ${
                            user.isOnline ? "bg-green-500" : "bg-red-500"
                          }`}
                        />
                      </div>
                      <div>
                        <div className="font-medium">{user.name}</div>
                        <div className="text-sm text-gray-500">
                          {user.isOnline ? (
                            <span className="text-green-600">Online</span>
                          ) : (
                            <span className="text-gray-500">Offline</span>
                          )}
                        </div>
                      </div>
                    </label>
                  </div>
                ))
              ) : (
                <div className="text-gray-500 text-center py-4">No users available</div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button className="flex-1 px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50" onClick={onClose}>
            Cancel
          </button>
          <button
            className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
            onClick={handleCreateGroup}
          >
            Create Group
          </button>
        </div>
      </div>
    </div>
  )
}
