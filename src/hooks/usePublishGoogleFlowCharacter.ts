import { useState, useCallback } from 'react'
import { toast } from './useToast'
import { useGoogleFlowEntities } from './useGoogleFlowEntities'

import { useMcpConnection } from './useMcpConnection'

export function usePublishGoogleFlowCharacter(
  projectSlug: string | null
) {
  const { callTool, state } = useMcpConnection()
  const [publishing, setPublishing] = useState(false)
  const { refresh } = useGoogleFlowEntities('character', callTool, state)

  const publishCharacter = useCallback(async (
    assetId: string,
    displayName: string,
    personalityNotes?: string,
    voiceId?: string
  ) => {
    if (state !== 'ready' || !projectSlug) return

    setPublishing(true)
    try {
      const result = await callTool('create_google_flow_character', {
        project_slug: projectSlug,
        image_slugs: [`@${assetId}`],
        display_name: displayName,
        personality_notes: personalityNotes,
        voice: voiceId
      })

      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }>)?.[0]?.text ?? 'Failed to publish character'
        toast({ title: 'Publish failed', description: msg, duration: 5000 })
        return null
      }

      const contentText = (result.content as Array<{ type: string; text: string }>)?.[0]?.text
      if (!contentText) return null

      // Expecting a string containing the character reference or a success message
      toast({ title: 'Character published', description: `Successfully published to Google Flow`, duration: 3000 })
      
      refresh()
      return contentText
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast({ title: 'Publish failed', description: msg, duration: 5000 })
      return null
    } finally {
      setPublishing(false)
    }
  }, [callTool, state, projectSlug, refresh])

  return { publishCharacter, publishing }
}
