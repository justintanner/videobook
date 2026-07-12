import { useState, useCallback } from 'react'
import { toast } from './useToast'
import { useGoogleFlowEntities } from './useGoogleFlowEntities'
import { parseCharacterMetadataObject } from '@/lib/character-name'

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
    options?: {
      personalityNotes?: string
      voiceId?: string
      /** Existing .character.json text (for merge after publish) */
      existingMetadata?: string
    },
  ) => {
    if (state !== 'ready' || !projectSlug) return null

    const meta = parseCharacterMetadataObject(options?.existingMetadata)
    const resolvedName = displayName.trim()
      || (typeof meta.display_name === 'string' ? meta.display_name.trim() : '')
    if (!resolvedName) {
      toast({
        title: 'Name required',
        description: 'Set a short display name before publishing to Google Flow',
        duration: 4000,
      })
      return null
    }

    setPublishing(true)
    try {
      const personalityNotes = options?.personalityNotes
        ?? (() => {
          const notes = meta.personality_notes ?? meta.personalityNotes ?? meta.notes
          return typeof notes === 'string' && notes.trim() ? notes.trim() : undefined
        })()

      const result = await callTool('create_google_flow_character', {
        project_slug: projectSlug,
        image_slugs: [`@${assetId}`],
        display_name: resolvedName,
        ...(personalityNotes ? { personality_notes: personalityNotes } : {}),
        ...(options?.voiceId ? { voice: options.voiceId } : {}),
      })

      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }>)?.[0]?.text ?? 'Failed to publish character'
        toast({ title: 'Publish failed', description: msg, duration: 5000 })
        return null
      }

      const contentText = (result.content as Array<{ type: string; text: string }>)?.[0]?.text
      if (!contentText) return null

      let characterRef: string | undefined
      try {
        const parsed = JSON.parse(contentText) as { character_ref?: string }
        characterRef = typeof parsed.character_ref === 'string' ? parsed.character_ref : undefined
      } catch {
        characterRef = undefined
      }

      // Persist the Google Flow ref on the local char-* asset so re-publish
      // and notebook refs can reuse it. Only char-* has .character.json.
      const charId = assetId.replace(/^@/, '')
      if (characterRef && charId.startsWith('char-')) {
        const merged = {
          ...meta,
          display_name: resolvedName,
          google_flow_character_ref: characterRef,
          google_flow_published_at: new Date().toISOString(),
        }
        const metaResult = await callTool('set_character_metadata', {
          project_slug: projectSlug,
          char_asset_id: charId,
          metadata: JSON.stringify(merged),
        })
        if (metaResult.isError) {
          const metaMsg = (metaResult.content as Array<{ type: string; text: string }>)?.[0]?.text
          toast({
            title: 'Published, but metadata save failed',
            description: metaMsg ?? 'Could not write .character.json',
            duration: 5000,
          })
        }
      }

      toast({
        title: 'Character published',
        description: characterRef
          ? `${resolvedName} → ${characterRef}`
          : `Published as ${resolvedName}`,
        duration: 3000,
      })

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
