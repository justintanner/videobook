import { useState, useCallback } from 'react'
import { uploadProjectFile, type UploadResult } from '@/lib/upload'

interface UseUploadFileResult {
  upload: (bookId: string, file: File) => Promise<void>
  uploading: boolean
  result: UploadResult | undefined
  error: string | undefined
}

export function useUploadFile(): UseUploadFileResult {
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<UploadResult | undefined>()
  const [error, setError] = useState<string | undefined>()

  const upload = useCallback(async (bookId: string, file: File) => {
    setUploading(true)
    setResult(undefined)
    setError(undefined)
    try {
      setResult(await uploadProjectFile(bookId, file, file.name))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }, [])

  return { upload, uploading, result, error }
}
