import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import type { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { GraphNode, GraphEdge } from '../common/shared';
import { NO_DOMAIN_COLOR, statusColor } from './colors';

let registered = false;
if (!registered) {
  cytoscape.use(fcose);
  registered = true;
}

interface EstateGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Ring color per domain. */
  palette: Map<string, string>;
  onSelect: (node: GraphNode | null) => void;
  focusDomain: string | null;
  query: string;
}

function shapeFor(kind: string): string {
  switch (kind) {
    case 'service':
      return 'round-rectangle';
    case 'database':
    case 'datastore':
      return 'barrel';
    case 'queue':
      return 'diamond';
    default:
      return 'round-hexagon';
  }
}

function matches(n: GraphNode, focusDomain: string | null, q: string): boolean {
  if (focusDomain && n.domain !== focusDomain) return false;
  if (q) {
    const hay = `${n.name} ${n.id} ${n.owner} ${n.domain} ${n.criticality}`.toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

export function EstateGraph({ nodes, edges, palette, onSelect, focusDomain, query }: EstateGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const focusActiveRef = useRef(false);

  // Build (and rebuild) the graph when the data changes.
  useEffect(() => {
    if (!containerRef.current) return;

    const maxCalls = Math.max(1, ...nodes.map((n) => n.calls));
    const edgeCalls = edges.map((e) => e.calls);
    const maxEdge = Math.max(1, ...edgeCalls);
    const nodeIds = new Set(nodes.map((n) => n.id));

    const elements: ElementDefinition[] = [
      ...nodes.map((n) => ({
        data: {
          id: n.id,
          label: n.name,
          fill: statusColor(n.status),
          border: palette.get(n.domain) ?? NO_DOMAIN_COLOR,
          shape: shapeFor(n.kind),
          // Traffic-scaled: busy services read as bigger.
          size: 30 + 42 * Math.sqrt(n.calls / maxCalls),
          node: n,
        },
      })),
      ...edges
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .map((e, i) => ({
          data: {
            id: `e${i}-${e.source}->${e.target}`,
            source: e.source,
            target: e.target,
            label: e.label,
            width: 1.5 + 5 * Math.sqrt(e.calls / maxEdge),
          },
        })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(fill)',
            shape: 'data(shape)' as cytoscape.Css.PropertyValueNode<any>,
            width: 'data(size)',
            height: 'data(size)',
            label: 'data(label)',
            color: '#e7ecf3',
            'font-size': 12,
            'font-weight': 600,
            'text-valign': 'bottom',
            'text-margin-y': 6,
            'text-wrap': 'wrap',
            'text-max-width': '130px',
            'text-outline-color': '#0c1018',
            'text-outline-width': 2,
            'border-width': 3,
            'border-color': 'data(border)',
            'transition-property': 'opacity, border-width',
            'transition-duration': 180 as unknown as number,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 'data(width)',
            'line-color': '#3a4453',
            'target-arrow-color': '#4a5568',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.9,
            'curve-style': 'bezier',
            'line-opacity': 0.75,
          },
        },
        {
          selector: 'node.hl',
          style: {
            'underlay-color': 'data(fill)',
            'underlay-opacity': 0.35,
            'underlay-padding': 10,
            'border-width': 4,
            'border-color': '#ffffff',
            'z-index': 20,
          },
        },
        {
          selector: 'edge.hl',
          style: {
            'line-color': '#8ea2bf',
            'target-arrow-color': '#8ea2bf',
            'line-opacity': 1,
            label: 'data(label)',
            'font-size': 9,
            color: '#c7d2e0',
            'text-rotation': 'autorotate',
            'text-background-color': '#0c1018',
            'text-background-opacity': 0.85,
            'text-background-padding': '2px',
            'z-index': 15,
          },
        },
        { selector: '.faded', style: { opacity: 0.1 } },
        {
          selector: 'node:selected',
          style: { 'border-width': 5, 'border-color': '#ffffff' },
        },
      ],
      layout: {
        name: 'fcose',
        quality: 'proof',
        animate: true,
        animationDuration: 500,
        padding: 40,
        nodeSeparation: 120,
        idealEdgeLength: 130,
        nodeRepulsion: 9000,
        gravity: 0.25,
      } as cytoscape.LayoutOptions,
    });

    const clearHighlight = () => {
      cy.elements().removeClass('hl faded');
    };

    const emphasize = (node: NodeSingular) => {
      const hood = node.closedNeighborhood();
      cy.elements().addClass('faded');
      hood.removeClass('faded');
      node.addClass('hl');
      node.connectedEdges().addClass('hl');
      hood.nodes().addClass('hl');
    };

    cy.on('mouseover', 'node', (evt) => {
      if (focusActiveRef.current) return; // don't fight an active toolbar focus
      emphasize(evt.target as NodeSingular);
    });
    cy.on('mouseout', 'node', () => {
      if (focusActiveRef.current) return;
      clearHighlight();
    });
    cy.on('tap', 'node', (evt) => {
      onSelect((evt.target as NodeSingular).data('node') as GraphNode);
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        onSelect(null);
        if (!focusActiveRef.current) clearHighlight();
      }
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges, palette, onSelect]);

  // Apply a persistent focus from the toolbar (domain + search) without a rebuild.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const active = Boolean(focusDomain) || query.trim().length > 0;
    focusActiveRef.current = active;
    cy.elements().removeClass('hl faded');

    if (!active) return;

    const matchIds = new Set(nodes.filter((n) => matches(n, focusDomain, query.trim())).map((n) => n.id));
    if (matchIds.size === 0) {
      cy.elements().addClass('faded');
      return;
    }

    cy.elements().addClass('faded');
    cy.nodes().forEach((node) => {
      if (!matchIds.has(node.id())) return;
      const hood = node.closedNeighborhood();
      hood.removeClass('faded');
      node.addClass('hl');
      node.connectedEdges().addClass('hl');
    });
  }, [focusDomain, query, nodes]);

  const fit = () => cyRef.current?.animate({ fit: { eles: cyRef.current.elements(), padding: 40 }, duration: 300 });
  const relayout = () =>
    cyRef.current
      ?.layout({ name: 'fcose', quality: 'proof', animate: true, animationDuration: 500, padding: 40 } as cytoscape.LayoutOptions)
      .run();

  return (
    <div className="graph-canvas-wrap">
      <div ref={containerRef} className="estate-graph" />
      <div className="graph-controls">
        <button onClick={fit} title="Fit to view">⤢ Fit</button>
        <button onClick={relayout} title="Re-run layout">↻ Layout</button>
      </div>
    </div>
  );
}
