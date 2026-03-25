export interface DOMRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AIElement {
  nodeId: number;
  backendNodeId: number;
  tagName: string;
  attributes: Record<string, string>;
  isInteractive: boolean;
  isVisible: boolean;
  bounds?: DOMRect;
  children: AIElement[];
  textContent?: string;
  highlightIndex?: number;
}

export interface AIState {
  url: string;
  title: string;
  tabs: Array<{ id: number; url: string; title: string }>;
  screenshot?: string; // base64
  elementTree: AIElement;
  pageInfo: {
    viewportWidth: number;
    viewportHeight: number;
    pageWidth: number;
    pageHeight: number;
    scrollX: number;
    scrollY: number;
  };
}
