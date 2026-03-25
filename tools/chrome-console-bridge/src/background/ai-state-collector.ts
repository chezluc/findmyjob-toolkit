import type { AIState, AIElement, DOMRect } from "../shared/ai-state";

export async function collectAIState(tabId: number): Promise<AIState> {
  const tab = await chrome.tabs.get(tabId);
  const debuggee = { tabId };

  await chrome.debugger.attach(debuggee, "1.3");
  try {
    const [snapshot, axTree, screenshot, layoutMetrics, tabs] = await Promise.all([
      chrome.debugger.sendCommand(debuggee, "DOMSnapshot.captureSnapshot", {
        computedStyles: [
          "display",
          "visibility",
          "opacity",
          "position",
          "z-index",
          "overflow"
        ],
        includeDOMRects: true,
        includePaintOrder: true
      }) as Promise<any>,
      chrome.debugger.sendCommand(debuggee, "Accessibility.getFullAXTree", {}) as Promise<any>,
      chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", { format: "jpeg", quality: 50 }) as Promise<any>,
      chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics", {}) as Promise<any>,
      chrome.tabs.query({ windowId: tab.windowId })
    ]);

    const viewport = layoutMetrics.cssVisualViewport || layoutMetrics.visualViewport;
    const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize;

    // Process snapshot and axTree into AIElement tree
    // This is a simplified version of browser-use's logic
    const elementTree = processDOMData(snapshot, axTree);

    return {
      url: tab.url ?? "",
      title: tab.title ?? "",
      tabs: tabs.map(t => ({ id: t.id!, url: t.url!, title: t.title! })),
      screenshot: screenshot.data,
      elementTree,
      pageInfo: {
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        pageWidth: contentSize.width,
        pageHeight: contentSize.height,
        scrollX: viewport.pageX,
        scrollY: viewport.pageY
      }
    };
  } finally {
    await chrome.debugger.detach(debuggee);
  }
}

function processDOMData(snapshot: any, axTree: any): AIElement {
  // Map backendNodeId to AXNode
  const axMap = new Map<number, any>();
  for (const node of axTree.nodes) {
    if (node.backendDOMNodeId) {
      axMap.set(node.backendDOMNodeId, node);
    }
  }

  // Simplified: use the first document in the snapshot
  const doc = snapshot.documents[0];
  const nodes = doc.nodes;
  const layout = doc.layout;
  const textBoxes = doc.textBoxes;

  // We need to build a tree from the flat nodes array
  // nodes.parentIndex tells us the structure
  const aiNodes: AIElement[] = nodes.nodeName.map((name: string, i: number) => {
    const backendNodeId = nodes.backendNodeId[i];
    const axNode = axMap.get(backendNodeId);
    
    // Extract attributes
    const attributes: Record<string, string> = {};
    if (nodes.attributes && nodes.attributes[i]) {
      const attrs = nodes.attributes[i];
      for (let j = 0; j < attrs.length; j += 2) {
        attributes[snapshot.strings[attrs[j]]] = snapshot.strings[attrs[j+1]];
      }
    }

    // Get bounds from layout
    let bounds: DOMRect | undefined;
    const layoutIndex = nodes.layoutIndex[i];
    if (layoutIndex !== -1 && layout) {
      const rect = layout.nodeRects[layoutIndex];
      bounds = { x: rect[0], y: rect[1], width: rect[2], height: rect[3] };
    }

    const tagName = snapshot.strings[nodes.nodeName[i]];
    const isInteractive = isElementInteractive(tagName, attributes, axNode);

    return {
      nodeId: i,
      backendNodeId,
      tagName,
      attributes,
      isInteractive,
      isVisible: isElementVisible(nodes, i, snapshot.strings),
      bounds,
      children: [],
      textContent: nodes.nodeValue[i] !== -1 ? snapshot.strings[nodes.nodeValue[i]] : undefined
    };
  });

  // Build the tree
  let root: AIElement | undefined;
  nodes.parentIndex.forEach((parentIdx: number, i: number) => {
    if (parentIdx === -1) {
      root = aiNodes[i];
    } else {
      aiNodes[parentIdx].children.push(aiNodes[i]);
    }
  });

  return root!;
}

function isElementInteractive(tagName: string, attributes: Record<string, string>, axNode: any): boolean {
  const interactiveTags = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"];
  if (interactiveTags.includes(tagName.toUpperCase())) return true;
  if (attributes.role === "button" || attributes.role === "link") return true;
  if (axNode && ["button", "link", "searchbox", "textbox"].includes(axNode.role?.value)) return true;
  return false;
}

function isElementVisible(nodes: any, index: number, strings: string[]): boolean {
  // Simplified visibility check
  return true; // For now
}
