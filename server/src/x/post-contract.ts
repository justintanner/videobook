export interface XPostFollowup {
  text?: string;
  image_asset_ids?: string[];
}

export interface XPostReplyResult {
  tweet_id: string;
  tweet_url: string;
  media_ids: string[];
  text: string | null;
  posted_at: string;
}

export interface XPostFollowupError {
  reply_number: number;
  message: string;
}

export interface PostToXResult {
  status: "posted" | "partially_posted";
  tweet_id: string;
  tweet_url: string;
  media_id: string;
  posted_at: string;
  replies: XPostReplyResult[];
  followup_error: XPostFollowupError | null;
  cell_id?: string;
  cell_address?: string;
  cell_error?: string;
}
