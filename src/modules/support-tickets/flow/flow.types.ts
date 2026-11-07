/**
 * The parent ticket flow (TAFSD-447): lanes the parent picks first, each with a
 * tree of steps that ends in a ticket (or a screen to open instead). Stored as
 * JSON in `ticket_flows.tree`, one row per version.
 */

/** Bump when a node type or setting is added that older apps cannot render. */
export const FLOW_SCHEMA = 1;

export const FLOW_NODE_TYPES = [
  'LANE',
  'QUESTION',
  'PICK_CHILD',
  'INFO',
  'TICKET',
  'SCREEN',
] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

/** App screens a SCREEN leaf can open. The apps map each key to a route. */
export const FLOW_SCREENS = [
  { key: 'fees', label: 'Fees' },
  { key: 'vouchers', label: 'Fee vouchers' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'leave', label: 'Leave requests' },
  { key: 'notices', label: 'Notice board' },
  { key: 'timetable', label: 'Timetable' },
  { key: 'profile', label: 'Student profile' },
] as const;

/** Icon names shared by the web builder and the apps (Material icon names). */
export const FLOW_ICONS = [
  'help',
  'school',
  'payments',
  'receipt_long',
  'directions_bus',
  'event',
  'person',
  'family_restroom',
  'report',
  'support_agent',
  'info',
  'calendar_month',
  'menu_book',
  'sports_soccer',
  'restaurant',
  'checkroom',
  'medical_services',
  'security',
  'call',
  'chat',
  'assignment',
  'warning',
  'star',
  'campaign',
  'apps',
  'badge',
  'computer',
  'gavel',
  'how_to_reg',
  'swap_horiz',
  'savings',
  'schedule',
] as const;

/** Lane colours (fixed palette so the app stays consistent). */
export const FLOW_COLORS = [
  '#2563EB',
  '#16A34A',
  '#EA580C',
  '#9333EA',
  '#DC2626',
  '#0891B2',
  '#CA8A04',
  '#DB2777',
  '#4B5563',
] as const;

export interface FlowConditions {
  campus_ids?: number[];
  segment_ids?: number[];
  class_ids?: number[];
  /** Only after a PICK_CHILD: shown when a child was picked (WITH) or "not about a child" (WITHOUT). */
  child?: 'WITH' | 'WITHOUT';
}

export interface LaneSettings {
  color: string;
  legacy_category: 'GENERAL' | 'FINANCIAL';
  fallback_queue_id?: number | null;
  description?: string;
  description_ur?: string;
  prompt?: string;
  prompt_ur?: string;
}

export interface QuestionSettings {
  /** Heading over this node's answers. */
  prompt?: string;
  prompt_ur?: string;
}

export interface PickChildSettings {
  /** Heading over the child list. */
  prompt?: string;
  prompt_ur?: string;
  allow_none: boolean;
  none_label?: string;
  none_label_ur?: string;
  /** Heading over the answers after the child is chosen. */
  then_prompt?: string;
  then_prompt_ur?: string;
}

export interface InfoSettings {
  body: string;
  body_ur?: string;
  link_url?: string;
  link_label?: string;
  /** Button that carries on to this node's children. */
  continue_label?: string;
  continue_label_ur?: string;
}

export interface TicketSettings {
  /** Where the ticket goes when no routing rule claims it. */
  queue_id?: number | null;
  min_length?: number;
  attachments?: boolean;
  placeholder?: string;
  placeholder_ur?: string;
}

export interface ScreenSettings {
  screen: string;
}

export interface FlowNode {
  key: string;
  type: FlowNodeType;
  label: string;
  label_ur?: string;
  help?: string;
  help_ur?: string;
  icon?: string;
  conditions?: FlowConditions;
  settings?: Record<string, unknown>;
  children?: FlowNode[];
}

export interface FlowTree {
  schema: number;
  lanes: FlowNode[];
}

/** One step of a ticket's path, frozen at creation so later edits never rewrite history. */
export interface FlowPathStep {
  key: string;
  type: FlowNodeType;
  label: string;
}

export interface FlowIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  node_key?: string;
}

/** Where a child sits, for evaluating node conditions. */
export interface FlowPlacement {
  campus_id: number | null;
  class_id: number | null;
  segment_id: number | null;
}

export const FLOW_LIMITS = {
  maxDepth: 8,
  maxNodes: 400,
  maxLanes: 20,
  maxChildren: 30,
  labelLength: 80,
} as const;
export const DEFAULT_MIN_LENGTH = 20;
