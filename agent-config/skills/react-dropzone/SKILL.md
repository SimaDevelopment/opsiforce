---
name: react-dropzone
description: File uploads with drag-and-drop using react-dropzone — the drop zone, previews, validation errors, and sending the file to the App's backend and storing it. Use whenever users upload files, images, documents, or any binary data.
---

# react-dropzone — File Upload

## Drop zone component

```tsx
import { useDropzone } from "react-dropzone"
import { Upload, X, FileText, Image as ImageIcon } from "lucide-react"
import { cn } from "@/lib/utils"

function FileUpload({ onUpload, accept, maxFiles = 5, maxSize = 5 * 1024 * 1024 }: {
  onUpload: (files: File[]) => void
  accept?: Record<string, string[]>
  maxFiles?: number
  maxSize?: number
}) {
  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop: onUpload,
    accept: accept ?? { "image/*": [".png", ".jpg", ".jpeg", ".webp"] },
    maxSize,
    maxFiles,
  })

  return (
    <div>
      <div {...getRootProps()} className={cn(
        "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
        isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
      )}>
        <input {...getInputProps()} />
        <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {isDragActive ? "Drop files here" : "Drag files here or click to browse"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Max {maxFiles} files, {(maxSize / 1024 / 1024).toFixed(0)}MB each
        </p>
      </div>
      {fileRejections.length > 0 && (
        <p className="text-sm text-destructive mt-2">
          {fileRejections[0].errors[0].message}
        </p>
      )}
    </div>
  )
}
```

## Image preview with remove

```tsx
function ImagePreviewList({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  return (
    <div className="grid grid-cols-4 gap-2 mt-4">
      {files.map((file, i) => (
        <div key={i} className="relative group rounded-lg overflow-hidden border">
          <img src={URL.createObjectURL(file)} alt={file.name} className="w-full h-24 object-cover" />
          <button
            onClick={() => onRemove(i)}
            className="absolute top-1 right-1 rounded-full bg-background/80 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="h-3 w-3" />
          </button>
          <p className="text-xs truncate px-1 py-0.5">{file.name}</p>
        </div>
      ))}
    </div>
  )
}
```

## Upload to backend

Many drop zones are client-only (preview, then hand the `File[]` to another component). **When the uploaded file must reach the backend, Read references/backend-upload.md** for the base64-JSON receive-and-store endpoint (frontend `useMutation` + NestJS controller writing to `data/uploads/`).

## Common accept configurations

```tsx
{ "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"] }  // images
{ "application/pdf": [".pdf"] }                              // PDF
{ "text/csv": [".csv"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] }  // spreadsheets
{ "application/json": [".json"] }                            // JSON
```
