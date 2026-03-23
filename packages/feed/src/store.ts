/**
 * Feed Store — Quarry-backed persistence for the social feed.
 *
 * Posts are Messages in the `public-timeline` group channel.
 * Comments are thread replies on those messages.
 * Likes are tracked via metadata on a separate "reaction" document per post.
 */

import type {
  QuarryAPI,
  MessageFilter,
  ChannelFilter,
} from '@slice/quarry/api';
import type {
  Channel,
  Message,
  Document,
  Entity,
  EntityId,
  ElementId,
  ChannelId,
  DocumentId,
  MessageId,
  HydratedMessage,
} from '@slice/core';
import {
  ElementType,
  EntityTypeValue,
  ChannelTypeValue,
  VisibilityValue,
  JoinPolicyValue,
  ContentType,
  DocumentCategory,
  createGroupChannel,
  createEntity,
  createDocument,
  createMessage,
} from '@slice/core';

// ============================================================================
// Feed Types
// ============================================================================

export interface FeedPost {
  id: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  content: string;
  timestamp: string;
  likes: number;
  comments: FeedComment[];
}

export interface FeedComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
}

// ============================================================================
// Constants
// ============================================================================

const PUBLIC_TIMELINE_CHANNEL = 'public-timeline';
const SYSTEM_ENTITY_NAME = 'feed-system';
const HUMAN_ENTITY_NAME = 'human';

// ============================================================================
// Quarry Feed Store
// ============================================================================

export class QuarryFeedStore {
  private api: QuarryAPI;
  private channelId: ChannelId | null = null;
  private systemEntityId: EntityId | null = null;
  private humanEntityId: EntityId | null = null;
  private entityCache = new Map<string, Entity>();
  /** In-memory like tracking (since messages are immutable in Quarry) */
  private likesMap = new Map<string, Set<string>>();

  constructor(api: QuarryAPI) {
    this.api = api;
  }

  /**
   * Initialize the store: ensure system entity, human entity, and
   * public-timeline channel exist.
   */
  async init(): Promise<void> {
    const idConfig = this.api.getIdGeneratorConfig();

    // Ensure system entity
    let systemEntity = await this.api.lookupEntityByName(SYSTEM_ENTITY_NAME) as Entity | null;
    if (!systemEntity) {
      const entity = await createEntity({
        name: SYSTEM_ENTITY_NAME,
        entityType: EntityTypeValue.SYSTEM,
        createdBy: 'el-system' as EntityId,
        metadata: { role: 'system', description: 'Feed system entity' },
      }, idConfig);
      systemEntity = await this.api.create<Entity>(entity as any);
    }
    this.systemEntityId = systemEntity.id as unknown as EntityId;

    // Ensure human entity
    let humanEntity = await this.api.lookupEntityByName(HUMAN_ENTITY_NAME) as Entity | null;
    if (!humanEntity) {
      const entity = await createEntity({
        name: HUMAN_ENTITY_NAME,
        entityType: EntityTypeValue.HUMAN,
        createdBy: this.systemEntityId,
        metadata: { role: 'operator', description: 'Human user' },
      }, idConfig);
      humanEntity = await this.api.create<Entity>(entity as any);
    }
    this.humanEntityId = humanEntity.id as unknown as EntityId;

    // Ensure public-timeline channel
    const channels = await this.api.list<Channel>({
      type: ElementType.CHANNEL,
    } as ChannelFilter);

    let channel = channels.find(c => c.name === PUBLIC_TIMELINE_CHANNEL);
    if (!channel) {
      const ch = await createGroupChannel({
        name: PUBLIC_TIMELINE_CHANNEL,
        createdBy: this.systemEntityId,
        members: [this.systemEntityId, this.humanEntityId],
        description: 'Public timeline for the social feed',
        visibility: VisibilityValue.PUBLIC,
        joinPolicy: JoinPolicyValue.OPEN,
      }, idConfig);
      channel = await this.api.create<Channel>(ch as any);
    }
    this.channelId = channel.id as ChannelId;
  }

  /**
   * Ensure an entity exists in the channel for posting.
   * Returns the entity ID.
   */
  private async ensureEntityInChannel(entityId: string): Promise<EntityId> {
    if (!this.channelId) throw new Error('Store not initialized');

    // For known entities, try to add them to the channel
    try {
      const entity = await this.api.get<Entity>(entityId as unknown as ElementId);
      if (entity) {
        // Try to add member (will no-op if already a member in the channel)
        try {
          await this.api.addChannelMember(this.channelId, entityId as EntityId);
        } catch {
          // Already a member, ignore
        }
        return entityId as EntityId;
      }
    } catch {
      // Entity doesn't exist
    }

    // Fall back to human entity
    return this.humanEntityId!;
  }

  /**
   * Resolve an entity to a display name and role.
   */
  private async resolveEntity(entityId: EntityId): Promise<{ name: string; role: string }> {
    if (this.entityCache.has(entityId)) {
      const e = this.entityCache.get(entityId)!;
      return { name: e.name, role: (e.metadata?.role as string) || e.entityType };
    }

    try {
      const entity = await this.api.get<Entity>(entityId as unknown as ElementId);
      if (entity) {
        this.entityCache.set(entityId, entity);
        return { name: entity.name, role: (entity.metadata?.role as string) || entity.entityType };
      }
    } catch {
      // ignore
    }

    return { name: 'Unknown', role: 'system' };
  }

  /**
   * Convert a Quarry message + content to a FeedPost.
   */
  private async hydratePost(msg: Message | HydratedMessage): Promise<FeedPost> {
    // Get content
    let content = '';
    if ('content' in msg && typeof (msg as HydratedMessage).content === 'string') {
      content = (msg as HydratedMessage).content!;
    } else {
      const doc = await this.api.get<Document>(msg.contentRef as ElementId);
      content = doc?.content || '';
    }

    const { name, role } = await this.resolveEntity(msg.sender);
    const likes = this.likesMap.get(msg.id)?.size || 0;

    return {
      id: msg.id,
      agentId: msg.sender,
      agentName: (msg.metadata?.agentName as string) || name,
      agentRole: (msg.metadata?.agentRole as string) || role,
      content,
      timestamp: msg.createdAt,
      likes,
      comments: [], // Comments loaded separately
    };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get paginated feed posts (newest first).
   */
  async getFeed(cursor?: string, limit = 20): Promise<{ posts: FeedPost[]; nextCursor: string | null }> {
    if (!this.channelId) throw new Error('Store not initialized');

    const filter: MessageFilter = {
      type: ElementType.MESSAGE,
      channelId: this.channelId,
      threadId: null, // Root messages only (not comments)
      limit,
      orderBy: 'createdAt',
      orderDir: 'desc',
      hydrate: { content: true },
    } as MessageFilter;

    if (cursor) {
      filter.createdBefore = cursor;
    }

    const messages = await this.api.list<HydratedMessage>(filter);
    const posts = await Promise.all(messages.map(m => this.hydratePost(m)));
    const nextCursor = posts.length === limit ? posts[posts.length - 1].timestamp : null;

    return { posts, nextCursor };
  }

  /**
   * Get a single post by ID with its comments.
   */
  async getPost(postId: string): Promise<FeedPost | null> {
    const msg = await this.api.get<Message>(postId as ElementId, { hydrate: { content: true } } as any);
    if (!msg) return null;

    const post = await this.hydratePost(msg);
    post.comments = await this.getComments(postId);
    return post;
  }

  /**
   * Create a new feed post.
   */
  async createPost(opts: {
    content: string;
    agentId?: string;
    agentName?: string;
    agentRole?: string;
  }): Promise<FeedPost> {
    if (!this.channelId) throw new Error('Store not initialized');
    const idConfig = this.api.getIdGeneratorConfig();

    // Determine sender
    const senderId = opts.agentId
      ? await this.ensureEntityInChannel(opts.agentId)
      : this.humanEntityId!;

    // Create content document
    const doc = await createDocument({
      contentType: ContentType.TEXT,
      content: opts.content,
      createdBy: senderId,
      category: DocumentCategory.MESSAGE_CONTENT,
    }, idConfig);
    const savedDoc = await this.api.create<Document>(doc as any);

    // Create message in public-timeline channel
    const msg = await createMessage({
      channelId: this.channelId,
      sender: senderId,
      contentRef: savedDoc.id as DocumentId,
      metadata: {
        agentName: opts.agentName || undefined,
        agentRole: opts.agentRole || undefined,
      },
    }, idConfig);
    const savedMsg = await this.api.create<Message>(msg as any);

    return {
      id: savedMsg.id,
      agentId: senderId,
      agentName: opts.agentName || (senderId === this.humanEntityId ? 'You' : 'Agent'),
      agentRole: opts.agentRole || (senderId === this.humanEntityId ? 'human' : 'worker'),
      content: opts.content,
      timestamp: savedMsg.createdAt,
      likes: 0,
      comments: [],
    };
  }

  /**
   * Get comments on a post (thread replies).
   */
  async getComments(postId: string): Promise<FeedComment[]> {
    if (!this.channelId) throw new Error('Store not initialized');

    const filter: MessageFilter = {
      type: ElementType.MESSAGE,
      channelId: this.channelId,
      threadId: postId as MessageId,
      orderBy: 'createdAt',
      orderDir: 'asc',
      hydrate: { content: true },
    } as MessageFilter;

    const messages = await this.api.list<HydratedMessage>(filter);

    return Promise.all(messages.map(async (msg) => {
      let content = '';
      if ('content' in msg && typeof msg.content === 'string') {
        content = msg.content;
      } else {
        const doc = await this.api.get<Document>(msg.contentRef as ElementId);
        content = doc?.content || '';
      }

      const { name } = await this.resolveEntity(msg.sender);

      return {
        id: msg.id,
        authorId: msg.sender,
        authorName: (msg.metadata?.agentName as string) || name,
        content,
        timestamp: msg.createdAt,
      };
    }));
  }

  /**
   * Add a comment to a post.
   */
  async addComment(postId: string, authorId: string, authorName: string, content: string): Promise<FeedComment> {
    if (!this.channelId) throw new Error('Store not initialized');
    const idConfig = this.api.getIdGeneratorConfig();

    const senderId = authorId
      ? await this.ensureEntityInChannel(authorId)
      : this.humanEntityId!;

    // Create content document
    const doc = await createDocument({
      contentType: ContentType.TEXT,
      content,
      createdBy: senderId,
      category: DocumentCategory.MESSAGE_CONTENT,
    }, idConfig);
    const savedDoc = await this.api.create<Document>(doc as any);

    // Create thread reply
    const msg = await createMessage({
      channelId: this.channelId,
      sender: senderId,
      contentRef: savedDoc.id as DocumentId,
      threadId: postId as MessageId,
      metadata: { agentName: authorName },
    }, idConfig);
    const savedMsg = await this.api.create<Message>(msg as any);

    return {
      id: savedMsg.id,
      authorId: senderId,
      authorName,
      content,
      timestamp: savedMsg.createdAt,
    };
  }

  /**
   * Toggle like on a post. Returns new like count.
   */
  toggleLike(postId: string, userId = 'operator'): { likes: number; liked: boolean } {
    if (!this.likesMap.has(postId)) {
      this.likesMap.set(postId, new Set());
    }
    const likeSet = this.likesMap.get(postId)!;

    if (likeSet.has(userId)) {
      likeSet.delete(userId);
      return { likes: likeSet.size, liked: false };
    } else {
      likeSet.add(userId);
      return { likes: likeSet.size, liked: true };
    }
  }

  /**
   * Get the channel ID.
   */
  getChannelId(): ChannelId | null {
    return this.channelId;
  }

  /**
   * Get the human entity ID.
   */
  getHumanEntityId(): EntityId | null {
    return this.humanEntityId;
  }

  /**
   * Get the system entity ID.
   */
  getSystemEntityId(): EntityId | null {
    return this.systemEntityId;
  }
}
