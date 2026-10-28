import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import type { Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { GraphProjection } from '../common/portfolio';
import { domainPalette, statusColor } from './colors';

cytoscape.use(fcose);
const layoutOptions = { name: 'fcose', animate: false, quality: 'default', padding: 55, nodeSeparation: 100 };

interface Props {
  projection: GraphProjection;
  selected: string | null;
  emphasizedApps: Set<string> | null;
  traceEdges: Set<string> | null;
  query: string;
  onSelect: (id: string, edge: boolean) => void;
}

export function EstateGraph({ projection, selected, emphasizedApps, traceEdges, query, onSelect }: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const core = useRef<Core | null>(null);
  const viewport = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  const selectRef = useRef(onSelect);
  const activeFocus = useRef(false);
  selectRef.current = onSelect;
  activeFocus.current = Boolean(emphasizedApps || query);

  useEffect(() => {
    if (!container.current) return;
    const palette = domainPalette(projection.nodes.map((n) => n.domain));
    const maxVolume = Math.max(1, ...projection.nodes.map((n) => n.volume));
    const elements = [
      ...projection.nodes.map((n) => ({
        data: {
          id: n.id, label: n.label, kind: n.kind, entityId: n.entityId, shape: n.shape,
          parent: n.parent, fill: statusColor(n.status), ring: palette.get(n.domain) || '#7b8c9f',
          size: n.kind === 'domain' ? 100 : 35 + 35 * Math.sqrt(n.volume / maxVolume),
        },
      })),
      ...projection.edges.map((e) => ({
        data: {
          id: e.id, source: e.source, target: e.target, label: e.label, relation: e.relation,
          width: e.relation === 'calls' ? 1.5 + Math.min(4, Math.log10(1 + e.calls)) : 1.5,
          failed: e.failed,
        },
      })),
    ];
    const cy = cytoscape({
      container: container.current, elements, minZoom: 0.15, maxZoom: 3,
      style: [
        { selector: 'node', style: {
          'background-color': 'data(fill)', 'border-color': 'data(ring)', 'border-width': 3,
          width: 'data(size)', height: 'data(size)', shape: 'round-rectangle', label: 'data(label)',
          color: '#e8edf4', 'font-size': 12, 'text-wrap': 'wrap', 'text-max-width': '180px',
          'text-valign': 'bottom', 'text-margin-y': 7, 'text-outline-color': '#0b0f17',
          'text-outline-width': 2,
        } },
        { selector: 'node[kind="domain"]', style: {
          'font-size': 15, 'font-weight': 700, width: 140, height: 85, 'text-valign': 'center', 'text-margin-y': 0,
        } },
        { selector: ':parent', style: {
          'background-opacity': 0.08, 'border-style': 'dashed', 'border-width': 1,
          padding: '25px', 'text-valign': 'top', 'text-margin-y': -10,
        } },
        { selector: 'node[shape="barrel"]', style: { shape: 'barrel' } },
        { selector: 'node[shape="diamond"]', style: { shape: 'diamond' } },
        { selector: 'node[shape="round-hexagon"]', style: { shape: 'round-hexagon' } },
        { selector: 'edge', style: {
          width: 'data(width)', 'line-color': '#52637a', 'target-arrow-color': '#7186a1',
          'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.9,
        } },
        { selector: 'edge[failed > 0]', style: { 'line-color': '#ec7578', 'target-arrow-color': '#ec7578' } },
        { selector: 'edge[relation="telemetry"]', style: {
          'line-style': 'dashed', 'line-color': '#759beb', 'target-arrow-color': '#759beb',
        } },
        { selector: 'edge[relation="hosting"]', style: {
          'line-style': 'dotted', 'line-color': '#bd94ec', 'target-arrow-color': '#bd94ec',
        } },
        { selector: '.dim', style: { opacity: 0.16 } },
        { selector: '.hover-dim', style: { opacity: 0.2 } },
        { selector: 'edge.hovered', style: {
          label: 'data(label)', color: '#edf7ff', 'font-size': 10, 'text-background-color': '#121924',
          'text-background-opacity': 1, 'text-background-padding': '3px',
        } },
        { selector: '.focus', style: { 'border-width': 5, 'border-color': '#ffffff' } },
        { selector: 'edge.focus', style: {
          'line-color': '#55d6bb', 'target-arrow-color': '#55d6bb', width: 5, label: 'data(label)',
          color: '#edf7ff', 'font-size': 10, 'text-background-color': '#121924',
          'text-background-opacity': 1, 'text-background-padding': '3px', 'text-wrap': 'wrap',
        } },
      ],
    });
    const old = core.current;
    if (old) old.destroy();
    core.current = cy;
    cy.on('tap', 'node', (event) => selectRef.current(event.target.id(), false));
    cy.on('tap', 'edge', (event) => selectRef.current(event.target.id(), true));
    cy.on('mouseover', 'node, edge', (event) => {
      if (activeFocus.current) return;
      cy.elements().addClass('hover-dim');
      const target = event.target;
      const neighbors = target.isNode() ? target.closedNeighborhood() : target.connectedNodes().union(target);
      neighbors.removeClass('hover-dim');
      neighbors.ancestors().removeClass('hover-dim');
      target.addClass('hovered');
      if (target.isNode()) target.connectedEdges().addClass('hovered');
    });
    cy.on('mouseout', 'node, edge', () => cy.elements().removeClass('hover-dim hovered'));
    const priorPositions = new Map<string, { x: number; y: number }>();
    for (const n of cy.nodes()) {
      const position = positionCache.get(n.id());
      if (position) { n.position(position); priorPositions.set(n.id(), position); }
    }
    if (priorPositions.size !== cy.nodes().length) {
      cy.layout(layoutOptions).run();
    } else if (viewport.current) {
      cy.zoom(viewport.current.zoom);
      cy.pan(viewport.current.pan);
    } else cy.fit(undefined, 55);
    cy.on('position', 'node', (event) => positionCache.set(event.target.id(), { ...event.target.position() }));
    for (const n of cy.nodes()) positionCache.set(n.id(), { ...n.position() });
    const observer = new ResizeObserver(() => cy.resize());
    observer.observe(container.current);
    return () => {
      viewport.current = { zoom: cy.zoom(), pan: { ...cy.pan() } };
      observer.disconnect();
      cy.destroy();
      if (core.current === cy) core.current = null;
    };
  }, [projection]);

  useEffect(() => {
    const cy = core.current;
    if (!cy) return;
    cy.elements().removeClass('focus dim');
    const matches = projection.nodes.filter((n) =>
      (!query || `${n.label} ${n.entityId} ${n.domain}`.toLowerCase().includes(query.toLowerCase())) &&
      (!emphasizedApps || emphasizedApps.has(n.entityId) || n.kind === 'domain'));
    if (query || emphasizedApps) {
      cy.elements().addClass('dim');
      for (const n of matches) {
        const element = cy.getElementById(n.id);
        element.removeClass('dim');
        element.ancestors().removeClass('dim');
        if (!emphasizedApps) element.closedNeighborhood().removeClass('dim');
      }
      for (const e of projection.edges) {
        if (traceEdges ? e.connections.some((id) => traceEdges.has(id))
          : matches.some((n) => n.id === e.source) && matches.some((n) => n.id === e.target)) {
          cy.getElementById(e.id).removeClass('dim').addClass('focus');
          cy.getElementById(e.source).removeClass('dim');
          cy.getElementById(e.target).removeClass('dim');
        }
      }
    }
    if (selected) cy.getElementById(selected).addClass('focus');
  }, [projection, selected, emphasizedApps, traceEdges, query]);

  return <div className="graph-canvas-wrap">
    <div ref={container} className="estate-graph" role="img"
      aria-label="Interactive dependency graph. The adjacent app and connection lists provide keyboard navigation." />
    <div className="graph-controls">
      <button onClick={() => core.current?.fit(undefined, 55)}>Fit</button>
      <button onClick={() => core.current?.layout(layoutOptions).run()}>Layout</button>
    </div>
  </div>;
}

const positionCache = new Map<string, { x: number; y: number }>();
