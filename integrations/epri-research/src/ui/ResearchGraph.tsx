import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Branch,CheckOne,FileText,Flask,FolderOpen,Connection,ZoomIn,ZoomOut,FullScreen} from '@icon-park/react';
import {layoutResearchProgressGraph} from '../reused/science/researchProgressGraph';
export type GraphNode = {id:string;parentIds?:string[];order?:number;title:string;summary?:string;label?:string;status?:string;tone?:string;meta?:string;basisCount?:number;raw?:any};
const icons:any={setup:FolderOpen,experiment:Flask,decision:Branch,report:FileText,evidence:CheckOne};
export default function ResearchGraph({nodes,selectedId,onSelect,graphKey}: {nodes:GraphNode[];selectedId?:string;onSelect:(node:GraphNode)=>void;graphKey:string}) {
  const viewport=useRef<HTMLDivElement>(null), drag=useRef<any>(null);
  const [scale,setScale]=useState(1);
  const layout=useMemo(()=>layoutResearchProgressGraph(nodes,{nodeWidth:300,nodeHeight:160,columnGap:56,rowGap:36,paddingX:28,paddingY:28}),[nodes]);
  const positioned=new Map(layout.nodes.map(n=>[n.id,n]));
  const focus=(next:number)=>{const el=viewport.current;if(!el)return;const node=positioned.get(selectedId || '') || layout.nodes[0];setScale(next);requestAnimationFrame(()=>{if(node)el.scrollTo(Math.max(0,(node.x+node.width/2)*next-el.clientWidth/2),Math.max(0,(node.y+node.height/2)*next-el.clientHeight/2));});};
  // Preserve readable text; large routes remain scrollable instead of shrinking to fit their full height.
  const fit=()=>{const el=viewport.current;if(el)focus(Math.min(1,Math.max(.9,(el.clientWidth-24)/layout.width)));};
  useEffect(()=>{const id=requestAnimationFrame(()=>focus(1));return()=>cancelAnimationFrame(id);},[graphKey,nodes.length]);
  const zoom=(factor:number)=>{const el=viewport.current;if(!el)return;const next=Math.min(2,Math.max(.5,scale*factor));const x=(el.scrollLeft+el.clientWidth/2)/scale,y=(el.scrollTop+el.clientHeight/2)/scale;setScale(next);requestAnimationFrame(()=>el.scrollTo(Math.max(0,x*next-el.clientWidth/2),Math.max(0,y*next-el.clientHeight/2)));};
  if(!nodes.length)return <div className="science-empty"><h3>还没有可展示的节点</h3><p>保存研究阶段或关联已有项目仓库后，这里会展示真实记录。</p></div>;
  return <div className="research-graph">
    <div className="graph-toolbar"><span>{nodes.length} 个节点 · {layout.edges.length} 条关联</span><small>拖动或滚动查看，点击节点看详情</small><div><button aria-label="缩小研究图" disabled={scale<=.5} onClick={()=>zoom(1/1.2)}><ZoomOut size={17}/></button><output aria-label="研究图缩放比例">{Math.round(scale*100)}%</output><button aria-label="放大研究图" disabled={scale>=2} onClick={()=>zoom(1.2)}><ZoomIn size={17}/></button><button title="按宽度调整并保留可读字号，较长路线可拖动查看" onClick={()=>fit()}><FullScreen size={16}/>适应画布</button><button title="恢复原始字号并定位当前阶段" onClick={()=>focus(1)}>100%</button></div></div>
    {(layout.issues.missingParents.length>0 || layout.issues.unresolvedNodeIds.length>0) && <p className="graph-notice">部分前置节点不在当前视图中，已保留可见节点。可展开全部历史查看。</p>}
    <div ref={viewport} className="graph-viewport" tabIndex={0} aria-label="研究进展画布" onPointerDown={e=>{if(e.button!==0 || (e.target as Element).closest('button'))return;drag.current={x:e.clientX,y:e.clientY,left:e.currentTarget.scrollLeft,top:e.currentTarget.scrollTop};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(drag.current){e.currentTarget.scrollLeft=drag.current.left+drag.current.x-e.clientX;e.currentTarget.scrollTop=drag.current.top+drag.current.y-e.clientY;}}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
      <div className="graph-size" style={{width:layout.width*scale,height:layout.height*scale}}><div className="graph-content" style={{width:layout.width,height:layout.height,transform:`scale(${scale})`}}>
        <svg className="graph-edges" width={layout.width} height={layout.height} aria-hidden="true">{layout.edges.map(edge=>{const a=positioned.get(edge.sourceId)!,b=positioned.get(edge.targetId)!;const x=a.x+a.width,y=a.y+a.height/2,tx=b.x,ty=b.y+b.height/2,m=(x+tx)/2;return <path key={edge.id} d={`M ${x} ${y} C ${m} ${y}, ${m} ${ty}, ${tx} ${ty}`}/>;})}</svg>
        {layout.nodes.map(({node,x,y,width,height})=>{const Icon=icons[node.tone || ''] || Connection;return <button key={node.id} className="graph-node" data-tone={node.tone} data-status={node.status} data-graph-node={node.id} aria-label={node.title} aria-pressed={selectedId===node.id} style={{left:x,top:y,width,height}} onClick={()=>onSelect(node)}>
          <span className="graph-node-top"><span className="graph-node-icon"><Icon size={19} strokeWidth={1.7}/></span><strong title={node.title}>{node.title}</strong><small>{node.label}</small></span>
          <span className="graph-node-summary">{node.summary || '点击查看详情'}</span>
          <span className="graph-node-bottom"><span>{node.meta}</span>{node.basisCount!==undefined && <span>{node.basisCount} 项依据</span>}</span>
        </button>;})}
      </div></div>
    </div>
  </div>;
}
