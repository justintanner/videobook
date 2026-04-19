import { alibaba } from "@apicity/alibaba";
import type { ClipfirstFs } from "clipfirst-fs";
import { prepareAssetForUpload, uploadBytesToFreeHost } from "../upload.js";

// Upload an asset to DashScope's OSS bucket via GET /api/v1/uploads?action=getPolicy
// + OSS PostObject. The policy is model-scoped, so callers must pass the model
// name that will later receive this URL. Objects uploaded this way are private,
// so callers must reference them via `oss://{upload_dir}/{filename}` — DashScope
// resolves that scheme internally. A plain https URL would 403 during data
// inspection ("Don't have authorization to access the media resource"). Falls
// back to the free-host rotation if the policy fetch or OSS POST fails.
export async function uploadAssetToAlibaba(
  fs: ClipfirstFs,
  assetId: string,
  filename: string,
  projectSlug: string,
  model: string,
): Promise<string> {
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(
    fs,
    assetId,
    filename,
    projectSlug,
  );

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (apiKey) {
    try {
      return await uploadViaPolicy(apiKey, model, data, hashedFilename, contentType);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[alibaba-upload] native failed, falling back to free host: ${msg}`);
    }
  } else {
    console.warn("[alibaba-upload] DASHSCOPE_API_KEY not set, using free host");
  }

  return uploadBytesToFreeHost(data, hashedFilename);
}

async function uploadViaPolicy(
  apiKey: string,
  model: string,
  data: Uint8Array,
  hashedFilename: string,
  contentType: string,
): Promise<string> {
  const provider = alibaba({ apiKey, timeout: 60_000 });
  const policyRes = await provider.get.api.v1.uploads({ action: "getPolicy", model });
  const p = policyRes.data;

  const uploadDir = p.upload_dir.replace(/^\/+|\/+$/g, "");
  const key = `${uploadDir}/${hashedFilename}`;

  const form = new FormData();
  form.append("key", key);
  form.append("OSSAccessKeyId", p.oss_access_key_id);
  form.append("policy", p.policy);
  form.append("Signature", p.signature);
  form.append("x-oss-object-acl", p.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", p.x_oss_forbid_overwrite);
  form.append("Content-Type", contentType);
  form.append("success_action_status", "200");
  // `file` MUST be last — OSS PostObject spec.
  form.append("file", new Blob([new Uint8Array(data)], { type: contentType }), hashedFilename);

  const endpoint = p.upload_host.startsWith("http") ? p.upload_host : `https://${p.upload_host}`;
  const res = await fetch(endpoint, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OSS POST failed: ${res.status} ${res.statusText} ${body}`);
  }

  return `oss://${key}`;
}
