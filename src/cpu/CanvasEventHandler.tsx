import React, { memo, useEffect, useRef, useState } from 'react';
import { AffineMat2d } from '../utils/AffineMat2d';
import { assignImm, assignImmFull, clamp, getOrAddToMap, isNil, useFunctionRef } from '../utils/data';
import { isKeyWithModifiers, KeyboardOrder, Modifiers, useGlobalKeyboard } from '../utils/keyboard';
import { useCombinedMouseTouchDrag } from '../utils/pointer';
import { BoundingBox3d, projectOntoVector, segmentNearestPoint, Vec3 } from '../utils/vector';
import { ICanvasState, IEditSnapshot, IEditorState, IElRef, IHitTest, ISchematic, ISegment, IWireGraph, RefType } from './CpuModel';
import { editLayout, useEditorContext } from './Editor';
import { fixWire, wireToGraph, applyWires, checkWires, copyWireGraph, EPSILON, dragSegment, moveSelectedComponents, iterWireGraphSegments, refToString, wireUnlinkNodes, repackGraphIds } from './Wire';
import s from './CpuCanvas.module.scss';
import { multiSortStableAsc } from '../utils/array';
import { FullscreenOverlay } from '../utils/Portal';
import { CursorDragOverlay } from '../utils/CursorDragOverlay';
import { computeSubLayoutMatrix } from './CanvasRenderHelpers';

export const CanvasEventHandler: React.FC<{
    cvsState: ICanvasState,
    children: React.ReactNode;
}> = memo(function CanvasEventHandler({ cvsState, children }) {

    let [ctrlDown, setCtrlDown] = useState(false);
    let [canvasWrapEl, setCanvasWrapEl] = useState<HTMLDivElement | null>(null);
    let { editorState, setEditorState } = useEditorContext();


    useGlobalKeyboard(KeyboardOrder.MainPage, ev => {
        if (ev.key === "Control") {
            setCtrlDown(ev.type === "keydown");
        }
        if (isKeyWithModifiers(ev, "o", Modifiers.None) && ev.type === "keydown") {
            setEditorState(a => assignImm(a, { showExeOrder: !a.showExeOrder }));
        }
        if (isKeyWithModifiers(ev, "p", Modifiers.None) && ev.type === "keydown") {
            setEditorState(a => assignImm(a, { transparentComps: !a.transparentComps }));
        }
        if (ev.key === "Delete") {
            setEditorState(editLayout(true, layout => {

                let refStrs = new Set(layout.selected.map(s => refToString(s)));
                function selectionHasRef(id: string, type: RefType) {
                    return refStrs.has(refToString({ id, type }));
                }

                let selectionPerWire = new Map<string, IElRef[]>();
                for (let ref of layout.selected) {
                    if (ref.type === RefType.WireNode || ref.type === RefType.WireSeg) {
                        getOrAddToMap(selectionPerWire, ref.id, () => []).push(ref);
                    }
                }

                let newLayout = assignImm(layout, {
                    comps: layout.comps.filter(c => !selectionHasRef(c.id, RefType.Comp)),
                    wires: layout.wires
                        .map(w => {
                            const refs = selectionPerWire.get(w.id);
                            if (refs) {
                                w = copyWireGraph(w);
                                for (let ref of refs) {
                                    if (ref.type === RefType.WireNode) {
                                        let node = w.nodes[ref.wireNode0Id!];
                                        for (let e of node.edges) {
                                            wireUnlinkNodes(node, w.nodes[e]);
                                        }
                                    } else if (ref.type === RefType.WireSeg) {
                                        let node0 = w.nodes[ref.wireNode0Id!];
                                        let node1 = w.nodes[ref.wireNode1Id!];
                                        wireUnlinkNodes(node0, node1);
                                    }
                                }
                                return repackGraphIds(w);
                            }
                            let newNodes = w.nodes.map(n => assignImm(n, { ref: n.ref && !refStrs.has(refToString(n.ref)) ? n.ref : undefined }));
                            return assignImm(w, { nodes: newNodes });
                        }),
                    selected: [],
                });
                return newLayout;
            }));
        }
    }, { receiveKeyUp: true });

    let handleWheelFuncRef = useFunctionRef(handleWheel);

    useEffect(() => {
        if (canvasWrapEl) {
            function wheelHandler(ev: WheelEvent) {
                handleWheelFuncRef.current(ev);
            }
            canvasWrapEl.addEventListener("wheel", wheelHandler, { passive: false });
            return () => {
                canvasWrapEl!.removeEventListener("wheel", wheelHandler);
            };
        }
    }, [canvasWrapEl, handleWheelFuncRef]);

    let [dragStart, setDragStart] = useCombinedMouseTouchDrag(cvsState?.canvas ?? null, ev => {
        return {
            mtx: editorState!.mtx,
            hovered: ev.button === 0 ? editorState!.hovered : null,
            modelPos: evToModel(ev, editorState.mtx),
            ctrlDown: ctrlDown,
            isSelecting: (ev.button === 0 && ctrlDown) || ev.button === 2,
        };
     }, function handleDrag(ev, ds, end) {
        let delta = new Vec3(ev.clientX - ds.clientX, ev.clientY - ds.clientY);

        if (ds.data.isSelecting) {
            let endPos = evToModel(ev, editorState.mtx);
            let startPos = ds.data.modelPos;
            let bb = new BoundingBox3d(startPos, endPos);

            let compRefs = editorState!.snapshot.comps.filter(c => {
                let bb2 = new BoundingBox3d(c.pos, c.pos.add(c.size));
                return bb.intersects(bb2);
            }).map(c => ({ type: RefType.Comp, id: c.id }));

            let wireRefs = editorState!.snapshot.wires.flatMap(w => {
                let nodeRefs: IElRef[] = [];
                for (let node of w.nodes) {
                    if (bb.contains(node.pos)) {
                        nodeRefs.push({ type: RefType.WireNode, id: w.id, wireNode0Id: node.id });
                    }
                }

                let segRefs: IElRef[] = [];
                iterWireGraphSegments(w, (node0, node1) => {
                    let bb2 = new BoundingBox3d(node0.pos, node1.pos);
                    if (bb.intersects(bb2)) {
                        segRefs.push({ type: RefType.WireSeg, id: w.id, wireNode0Id: node0.id, wireNode1Id: node1.id });
                    }
                });

                return [...nodeRefs, ...segRefs];
            });


            setEditorState(a => assignImm(a, {
                selectRegion: end ? null : bb,
                snapshot: assignImm(a.snapshot, {
                    selected: [...compRefs, ...wireRefs],
                }),
            }));

        } else if (!ds.data.hovered) {
            let newMtx = AffineMat2d.translateVec(delta).mul(ds.data.mtx);
            setEditorState(a => assignImm(a, { mtx: newMtx }));
        } else {
            let hoveredRef = ds.data.hovered.ref;

            if (hoveredRef.type === RefType.Comp) {
                let isSelected = editorState!.snapshot.selected.find(a => a.type === RefType.Comp && a.id === hoveredRef.id);
                if (isSelected) {
                    // handleComponentDrag(end, hoveredRef, ds.data.modelPos, evToModel(ev));
                    handleSelectionDrag(end, ds.data.modelPos, evToModel(ev, editorState.mtx));
                }
            } else if (hoveredRef.type === RefType.CompNode) {
                handleWireCreateDrag(end, hoveredRef, ds.data.modelPos, evToModel(ev, editorState.mtx));
            } else if (hoveredRef.type === RefType.WireSeg) {
                handleWireDrag(end, hoveredRef, ds.data.modelPos, evToModel(ev, editorState.mtx));
            } else if (hoveredRef.type === RefType.WireNode) {
                handleWireExtendDrag(end, hoveredRef, ds.data.modelPos, evToModel(ev, editorState.mtx));
            }
        }

        ev.stopPropagation();
        ev.preventDefault();
    }, function handleClick(ev, ds) {

        if (ds.data.hovered) {
            let hoveredRef = ds.data.hovered.ref;
            setEditorState(a => assignImm(a, {
                snapshot: assignImm(a.snapshot, {
                    selected: [hoveredRef],
                }),
            }));
        } else {
            setEditorState(a => assignImm(a, {
                snapshot: assignImm(a.snapshot, {
                    selected: [],
                }),
            }));
        }

        ev.stopPropagation();
        ev.preventDefault();
    });

    let showTransparentComponents = dragStart?.data.ctrlDown || ctrlDown || editorState.transparentComps;

    function handleSelectionDrag(end: boolean, origModelPos: Vec3, newModelPos: Vec3) {

        setEditorState(editLayout(end, layout => {
            let deltaPos = newModelPos.sub(origModelPos);
            let snappedDelta = snapToGrid(deltaPos);
            return moveSelectedComponents(layout, snappedDelta);
        }));
    }

    function handleWireCreateDrag(end: boolean, ref: IElRef, origModelPos: Vec3, newModelPos: Vec3) {
        setEditorState(editLayout(end, layout => {

            let startComp = layout.comps.find(c => c.id === ref.id)!;
            let startNode = startComp.ports.find(n => n.id === ref.compNodeId)!;
            let startPt = startComp.pos.add(startNode.pos);
            let endPt = snapToGrid(newModelPos);

            let isHorizStart = startNode.pos.x === 0 || startNode.pos.x === startComp.size.x;

            // split into horizontal and vertical segments
            // maybe drop some of the if's, and have a cleanup phase
            let segments: ISegment[] = [];
            if (isHorizStart) {
                segments.push({ p0: startPt, p1: new Vec3(endPt.x, startPt.y), comp0Ref: ref });
                segments.push({ p0: new Vec3(endPt.x, startPt.y), p1: endPt });
            } else {
                segments.push({ p0: startPt, p1: new Vec3(startPt.x, endPt.y), comp0Ref: ref });
                segments.push({ p0: new Vec3(startPt.x, endPt.y), p1: endPt });
            }

            let newWire: IWireGraph = fixWire(wireToGraph({
                id: '' + layout.nextWireId,
                segments: segments,
            }));

            let newWires = [...layout.wires, newWire];
            let newLayout = applyWires(assignImm(layout, { nextWireId: layout.nextWireId + 1, wires: newWires }), newWires, newWires.length - 1);

            return newLayout;
        }));
    }

    let grabDirRef = useRef<Vec3 | null>(null);

    /* We are dragging from the end of a segment. For now, assume it's a bare end.

    Behaviours, assuming a horiz segment:
        - dragging into the segment shortens it
        - dragging out from the segment lengthens it
        - we have a region around the segment end, and the direction through which we drag
            defines the direction of the new segment (initially)
        - then, we allow a dogleg, with that initial dir
        - the initial dir can be reset by dragging back into the region & then out again
        - what about if we dogleg while shortening? if we start with a horiz initial dir, then
            do a shorten + single extend in opposite direction, i.e. keep the elbow, rather than create a T junction
    */
    function handleWireExtendDrag(end: boolean, ref: IElRef, origModelPos: Vec3, newModelPos: Vec3) {
        setEditorState(editLayout(end, function handleWireExtendDrag(layout) {
            checkWires(editorState.snapshot.wires, 'handleWireExtendDrag (pre edit)');
            let wireIdx = editorState.snapshot.wires.findIndex(w => w.id === ref.id)!;
            let wire = copyWireGraph(editorState.snapshot.wires[wireIdx]);
            let delta = newModelPos.sub(origModelPos);
            let node = wire.nodes[ref.wireNode0Id!];
            let startPos = node.pos;

            let screenPos = modelToScreen(startPos, editorState.mtx);
            let mouseScreenPos = modelToScreen(newModelPos, editorState.mtx);
            let mouseDir = mouseScreenPos.sub(screenPos);
            let mouseDirSnapped = mouseDir.normalize().round();
            if (mouseDirSnapped.x !== 0 && mouseDirSnapped.y !== 0) {
                mouseDirSnapped.y = 0;
            }
            let grabDirPx = 20;
            if (!grabDirRef.current && mouseDir.len() > grabDirPx) {
                // want to make one of the 4 cardinal directions
                grabDirRef.current = mouseDirSnapped;
            } else if (mouseDir.len() < grabDirPx) {
                grabDirRef.current = null;
            }

            let grabDir = grabDirRef.current ?? mouseDirSnapped;

            if (end) {
                grabDirRef.current = null;
            }

            let endPos = snapToGrid(startPos.add(delta));

            let moveDelta = endPos.sub(startPos);

            let isReversing = false;
            let allDirs: Vec3[] = [];
            for (let node1Idx of node.edges) {
                let node1 = wire.nodes[node1Idx];
                let dir = node1.pos.sub(startPos).normalize();

                if (dir.dot(grabDir) > 1.0 - EPSILON) {
                    let newNode0Id = wire.nodes.length;
                    let newNode1Id = wire.nodes.length + 1;
                    // re-wire node 1 to point to new node
                    let midPos = startPos.add(projectOntoVector(moveDelta, grabDir));
                    node1.edges.push(newNode0Id);
                    node1.edges = node1.edges.filter(e => e !== node.id);
                    node.edges = node.edges.filter(e => e !== node1.id);
                    wire.nodes.push({ id: newNode0Id, pos: midPos, edges: [node1Idx, newNode1Id] });
                    wire.nodes.push({ id: newNode1Id, pos: endPos, edges: [newNode0Id] });
                    isReversing = true;
                    break;
                }
                allDirs.push(dir);
            }

            if (!isReversing) {
                if (node.edges.length === 1 && grabDir.dot(wire.nodes[node.edges[0]].pos.sub(startPos)) < -1.0 + EPSILON) {
                    // we're extending a bare end
                    let newNode0Id = wire.nodes.length;
                    let midPos = startPos.add(projectOntoVector(moveDelta, grabDir));
                    node.pos = midPos;
                    node.edges.push(newNode0Id);
                    wire.nodes.push({ id: newNode0Id, pos: endPos, edges: [node.id] });
                } else {
                    let newNode0Id = wire.nodes.length;
                    let newNode1Id = wire.nodes.length + 1;
                    let midPos = startPos.add(projectOntoVector(moveDelta, grabDir));
                    node.edges.push(newNode0Id);
                    wire.nodes.push({ id: newNode0Id, pos: midPos, edges: [node.id, newNode1Id] });
                    wire.nodes.push({ id: newNode1Id, pos: endPos, edges: [newNode0Id] });
                }
            }

            // how are we manipulating our graph?
            // guess we need to insert/remove nodes & their edges?

            let wires = [...layout.wires];
            wires[wireIdx] = wire;

            checkWires(wires, 'handleWireExtendDrag');

            return applyWires(layout, wires, wireIdx);
        }));

    }

    function handleWireDrag(end: boolean, ref: IElRef, origModelPos: Vec3, newModelPos: Vec3) {

        setEditorState(editLayout(end, layout => {
            let wireIdx = editorState.snapshot.wires.findIndex(w => w.id === ref.id)!;
            let wire = editorState.snapshot.wires[wireIdx];
            let delta = newModelPos.sub(origModelPos);
            let node0 = wire.nodes[ref.wireNode0Id!];
            let node1 = wire.nodes[ref.wireNode1Id!];

            // don't allow dragging of segments connected to components (since they're pinned)
            // probably want to support dragging by introducing a perp-segment though
            if (node0.ref || node1.ref) {
                return layout;
            }

            let isHoriz = node0.pos.y === node1.pos.y;
            if (isHoriz) {
                delta = new Vec3(0, delta.y);
            } else {
                delta = new Vec3(delta.x, 0);
            }

            let newWire = dragSegment(wire, ref.wireNode0Id!, ref.wireNode1Id!, delta);

            let wires = [...layout.wires];
            wires[wireIdx] = newWire;
            return applyWires(layout, wires, wireIdx);
        }));
    }

    function handleWheel(ev: WheelEvent) {
        let scale = editorState.mtx.a;
        let newScale = clamp(scale * Math.pow(1.0013, -ev.deltaY), 0.01, 100000) / scale;

        let modelPt = evToModel(ev, editorState.mtx);
        let newMtx = AffineMat2d.multiply(
            editorState.mtx,
            AffineMat2d.translateVec(modelPt),
            AffineMat2d.scale1(newScale),
            AffineMat2d.translateVec(modelPt.mul(-1)));

        setEditorState(a => assignImm(a, { mtx: newMtx }));
        ev.stopPropagation();
        ev.preventDefault();
    }

    function getRefUnderCursor(editorState: IEditorState, ev: React.MouseEvent, schematic?: ISchematic, mtx?: AffineMat2d, idPrefix: string = ''): IHitTest | null {
        let mousePt = evToModel(ev, mtx ?? editorState.mtx);
        let mousePtScreen = evToScreen(ev);

        mtx ??= editorState.mtx;
        schematic ??= editorState.snapshot;
        let comps = schematic.comps;

        let refsUnderCursor: IHitTest[] = [];

        for (let i = comps.length - 1; i >= 0; i--) {
            let comp = comps[i];
            for (let node of comp.ports) {
                let modelPos = comp.pos.add(node.pos);
                let nodeScreenPos = modelToScreen(modelPos, mtx);
                let modelDist = modelPos.dist(mousePt);
                let screenDist = nodeScreenPos.dist(mousePtScreen);
                if (screenDist < 10 || modelDist < 0.2) {
                    refsUnderCursor.push({
                        ref: { type: RefType.CompNode, id: idPrefix + comp.id, compNodeId: node.id },
                        distPx: screenDist,
                        modelPt: modelPos,
                    });
                }
            }
        }

        if (!showTransparentComponents) {
            for (let i = comps.length - 1; i >= 0; i--) {
                let comp = comps[i];
                let bb = new BoundingBox3d(comp.pos, comp.pos.add(comp.size));
                if (bb.contains(mousePt)) {

                    if (comp.hasSubSchematic) {
                        // need some test of whether we can click through to the sub-schematic,
                        // since still want to be able to select the component itself. Also should
                        // be related to zoom level
                        let def = editorState.compLibrary.getCompDef(comp.defId);
                        let subMtx = mtx.mul(computeSubLayoutMatrix(comp, def!, def!.subLayout!));

                        let subRef = getRefUnderCursor(editorState, ev, def!.subLayout!.layout, subMtx, idPrefix + comp.id + '|');

                        if (subRef) {
                            refsUnderCursor.push(subRef);
                        }
                    }

                    refsUnderCursor.push({
                        ref: { type: RefType.Comp, id: idPrefix + comp.id },
                        distPx: 0,
                        modelPt: mousePt,
                    });
                }
            }
        }

        let wires = schematic.wires;
        for (let i = wires.length - 1; i >= 0; i--) {
            let wire = wires[i];
            for (let node of wire.nodes) {
                let pScreen = modelToScreen(node.pos, mtx);
                let screenDist = pScreen.dist(mousePtScreen);
                if (screenDist < 10) {
                    refsUnderCursor.push({
                        ref: { type: RefType.WireNode, id: idPrefix + wire.id, wireNode0Id: node.id },
                        distPx: screenDist,
                        modelPt: screenToModel(pScreen, mtx),
                    });
                }
            }

            for (let node0 of wire.nodes) {
                let p0Screen = modelToScreen(node0.pos, mtx);

                for (let node1Idx of node0.edges) {
                    if (node1Idx <= node0.id) {
                        continue;
                    }
                    let node1 = wire.nodes[node1Idx];

                    let p1Screen = modelToScreen(node1.pos, mtx);
                    let isectPt = segmentNearestPoint(p0Screen, p1Screen, mousePtScreen);
                    let screenDist = isectPt.dist(mousePtScreen);
                    if (screenDist < 10) {
                        refsUnderCursor.push({
                            ref: { type: RefType.WireSeg, id: idPrefix + wire.id, wireNode0Id: node0.id, wireNode1Id: node1.id },
                            distPx: screenDist,
                            modelPt: screenToModel(isectPt, mtx),
                        });
                    }
                }
            }
        }

        return refsUnderCursor[0] ?? null;
    }

    function handleMouseMove(ev: React.MouseEvent) {

        if (editorState.dragCreateComp) {
            let compOrig = editorState.dragCreateComp.compOrig;
            let mousePos = snapToGrid(evToModel(ev, editorState.mtx));

            let applyFunc = (a: IEditSnapshot): IEditSnapshot => {
                let newComp = assignImm(compOrig, {
                    id: '' + a.nextCompId,
                    pos: mousePos,
                });
                return assignImm(a, {
                    nextCompId: a.nextCompId + 1,
                    comps: [...a.comps, newComp],
                });
            };

            setEditorState(a => assignImm(a, {
                dragCreateComp: assignImm(a.dragCreateComp, { applyFunc }),
            }));

            return;
        }

        let isect = getRefUnderCursor(editorState, ev);

        setEditorState(a => assignImm(a, { hovered: assignImmFull(a.hovered, isect) }));
    }

    function handleMouseEnter(ev: React.MouseEvent) {
    }

    function handleMouseLeave(ev: React.MouseEvent) {
        setEditorState(a => assignImm(a, {
            hovered: null,
            dragCreateComp: a.dragCreateComp ? assignImm(a.dragCreateComp, {
                applyFunc: undefined
            }) : undefined,
        }));
    }

    function handleMouseDown(ev: React.MouseEvent) {
        if (!editorState) {
            return;
        }

        setDragStart(ev);
    }

    let cursor: string | undefined;
    if (dragStart && dragStart.data.hovered?.ref.type === RefType.Comp) {
        cursor = 'move';

    } else if (editorState.hovered) {
        let hoveredRef = editorState.hovered.ref;
        if (hoveredRef.type === RefType.CompNode) {
            cursor = 'crosshair';
        } else if (hoveredRef.type === RefType.WireSeg) {
            let wire = editorState.snapshot.wires.find(w => w.id === hoveredRef.id);
            if (wire) {
                let node0 = wire.nodes[hoveredRef.wireNode0Id!];
                let node1 = wire.nodes[hoveredRef.wireNode1Id!];
                if (node0 && node1) {
                    let isHoriz = node0.pos.y === node1.pos.y;
                    cursor = isHoriz ? 'ns-resize' : 'ew-resize';
                }
            }
        } else if (hoveredRef.type === RefType.WireNode) {
            cursor = 'crosshair';
        } else if (hoveredRef.type === RefType.Comp) {

            if (editorState.snapshot.selected.find(a => a.type === RefType.Comp && a.id === hoveredRef.id)) {
                cursor = 'move';
            }

        }
    }

    let dragCursor: string | undefined;
    if (dragStart && !dragStart.data.hovered) {
        dragCursor = 'cursor-grabbing';
    }

    function snapToGrid(pt: Vec3) {
        return pt.round();
    }

    function evToModel(ev: { clientX: number, clientY: number }, mtx: AffineMat2d) {
        return mtx.mulVec3Inv(evToScreen(ev));
    }

    function evToScreen(ev: { clientX: number, clientY: number }) {
        let bcr = cvsState?.canvas.getBoundingClientRect();
        return new Vec3(ev.clientX - (bcr?.x ?? 0), ev.clientY - (bcr?.y ?? 0));
    }

    function modelToScreen(pt: Vec3, mtx: AffineMat2d) {
        return mtx.mulVec3(pt);
    }

    function screenToModel(pt: Vec3, mtx: AffineMat2d) {
        return mtx.mulVec3Inv(pt);
    }

    return <div
        className={s.canvasEventSurface}
        ref={setCanvasWrapEl}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onContextMenu={ev => ev.preventDefault()}
        style={{ cursor }}>
        {children}
        {dragCursor && <CursorDragOverlay className={dragCursor} />}
    </div>;
});

