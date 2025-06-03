export function ImageUpload({ imageFiles, setImageFiles, handleImageUpload, isUploading, disabled }) {
  return (
    <div className="flex gap-2 mt-2">
      <div className="flex-1">
        <input
          type="file"
          id="file-input"
          multiple
          accept="image/*"
          onChange={(e) => setImageFiles(Array.from(e.target.files))}
          disabled={disabled || isUploading}
          className="hidden"
        />
        <label
          htmlFor="file-input"
          className="block w-full px-3 py-2 border border-gray-300 rounded-md cursor-pointer hover:bg-gray-50 text-center"
        >
          {imageFiles.length > 0
            ? `${imageFiles.length} image${imageFiles.length > 1 ? "s" : ""} selected`
            : "Select Images"}
        </label>
      </div>

      <button
        onClick={handleImageUpload}
        disabled={disabled || imageFiles.length === 0 || isUploading}
        className="px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
      >
        {isUploading ? "Uploading..." : "Upload"}
      </button>
    </div>
  )
}
