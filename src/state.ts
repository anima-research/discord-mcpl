import { randomUUID } from 'node:crypto';

export interface SentMessage {
  discordMessageId: string;
  channelId: string;
  content: string;
  timestamp: string;
}

export interface Checkpoint {
  id: string;
  parent: string | null;
  sentCount: number;
}

export class StateTracker {
  private sentMessages: SentMessage[] = [];
  private checkpoints: Map<string, Checkpoint> = new Map();
  private currentCheckpoint: string | null = null;

  recordSent(discordMessageId: string, channelId: string, content: string): void {
    this.sentMessages.push({
      discordMessageId,
      channelId,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  createCheckpoint(): string {
    const id = `chk_${randomUUID().slice(0, 8)}`;
    this.checkpoints.set(id, {
      id,
      parent: this.currentCheckpoint,
      sentCount: this.sentMessages.length,
    });
    this.currentCheckpoint = id;
    return id;
  }

  get current(): string | null {
    return this.currentCheckpoint;
  }

  rollback(checkpointId: string): SentMessage[] | null {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return null;

    const toDelete = this.sentMessages.slice(checkpoint.sentCount);

    this.sentMessages = this.sentMessages.slice(0, checkpoint.sentCount);
    this.currentCheckpoint = checkpointId;

    return toDelete;
  }

  getCheckpointState(): { checkpoint: string; parent: string | null } | null {
    if (!this.currentCheckpoint) return null;
    const cp = this.checkpoints.get(this.currentCheckpoint);
    if (!cp) return null;
    return { checkpoint: cp.id, parent: cp.parent };
  }
}
