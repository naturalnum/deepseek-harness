import AccessWorkspace,{AccountLogin} from './AccessWorkspace';
import DocumentIndex from './DocumentIndex';
import ArchiveWorkspace from './ArchiveWorkspace';
import powerDataQuality from '../../examples/power-data-quality.aimd';
import EngineWorkspace from './EngineWorkspace';
import {TaskRecordLink} from './ResearchTasks';
import RecordCalculationSetup from './RecordCalculationSetup';
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Application, ArrowLeft, ArrowRight, BookOpen, ChartHistogram, CheckOne, Connection, FileText, Flask, FolderOpen, Notes, Refresh, Search, Transfer } from '@icon-park/react';
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import "@arco-design/web-react/dist/css/arco.css";
import Workspace from "../reused/protocol/AimdProtocolWorkspace";
import { downloadTextContent } from "./adapters/download";
import { api, sessionId } from "./adapters/api";
import ConversationWorkbench, { artifactCategory } from "./ConversationWorkbench";
import ScienceWorkspace from './ScienceWorkspace';
import "./style.css";
import { publicAddresses } from '../public-addresses.mjs';
import {embedded,platformIdentity,openWorkbench} from './embedded-workbench.mjs';
import {applyWorkbenchTheme} from './workbench-theme.mjs';
void i18n
  .use(initReactI18next)
  .init({
    lng: "zh",
    fallbackLng: "zh",
    resources: { zh: { translation: {} } },
    interpolation: { escapeValue: false },
  });
const request = () => crypto.randomUUID();
const conversationUrl = publicAddresses().harness;
if (sessionId) conversationUrl.searchParams.set('researchSession', sessionId);
const returnToConversation = embedded ? null : <a className="return-to-chat" href={conversationUrl.href}><ArrowLeft size={16} aria-hidden="true" />返回对话</a>;
const navigation = [
  ['overview', Application, '研究总览'],
  ['deliverables', FolderOpen, '对话成果'],
  ['science', Connection, '研究路线与证据'],
  ['engine', Flask, '实验与结果'],
  ['archives', Transfer, '导入与归档'],
  ['protocols', BookOpen, '协议与方法'],
  ['records', Notes, '实验记录'],
  ['literature', Search, '文献检索'],
  ['artifacts', ChartHistogram, '科研图表'],
  ['access', Connection, '账号与项目'],
] as const;
const visibleNavigation = navigation.filter(([id]) => !platformIdentity || id !== 'access');
function App() {
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [key, setKey] = useState(""),
    [tab, setTab] = useState(visibleNavigation.some(([id])=>id===new URLSearchParams(location.search).get('tab')) ? new URLSearchParams(location.search).get('tab')! : embedded?'deliverables':'overview'),
    [selected, setSelected] = useState<any>(null),
    [seed, setSeed] = useState<any>(null),
    [generation, setGeneration] = useState(0),
    [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [protocolDirty, setProtocolDirty] = useState(false);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>applyWorkbenchTheme(event);
    window.addEventListener('message',receive);
    if(window.parent!==window)window.parent.postMessage({type:'research-theme-ready',sessionId},publicAddresses().harness.origin);
    return()=>window.removeEventListener('message',receive);
  },[]);
  const [preview, setPreview] = useState<any>(null), [showArchived, setShowArchived] = useState(false), [recordQuery, setRecordQuery] = useState("");
  const previewDialog = useRef<HTMLDialogElement>(null);
  const actionDialog = useRef<HTMLDialogElement>(null);
  const [action, setAction] = useState<{ title: string; detail: string; reason?: boolean; run: (reason: string) => void | Promise<void> } | null>(null);
  const [reason, setReason] = useState(""), [actionError, setActionError] = useState("");
  const askAction = (next: NonNullable<typeof action>) => { setReason(""); setActionError(""); setAction(next); };
  const [literatureSource, setLiteratureSource] = useState("local"), [maxResults, setMaxResults] = useState(5);
  const searchController = useRef<AbortController | null>(null);
  const current = useRef<any>(null);
  const [source, setSource] = useState(powerDataQuality),
    [protocolId, setProtocolId] = useState("power-data-quality"),
    [version, setVersion] = useState("1.0.0"),
    [query, setQuery] = useState(""),
    [papers, setPapers] = useState<any>(null),
    [chart, setChart] = useState("");
  const refresh = async () => {
    const s = await api("state", { includeArchived: true });
    setState(s);
    return s;
  };
  useEffect(() => {
    void refresh().then(s => { const id = new URLSearchParams(location.search).get('record'); const r = s.records.find((r: any) => r.id === id); if (r) open(r); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const fn = (event: Event) => {
      const path = (event as CustomEvent).detail;
      if(path&&typeof path==='object'&&typeof path.content==='string'){setPreview(path);return;}
      const protocol = state?.protocols.find((p: any) => p.id + ".aimd" === path && p.id === selected?.protocolId && p.version === selected?.protocolVersion);
      if (protocol) setPreview(protocol);
      else setError("没有找到目标文档，请重新载入记录后再试。");
    };
    window.addEventListener("research-open-document", fn);
    return () => window.removeEventListener("research-open-document", fn);
  }, [state, selected]);
  useEffect(() => { if (preview && !previewDialog.current?.open) previewDialog.current?.showModal(); }, [preview]);
  useEffect(() => { if (action && !actionDialog.current?.open) actionDialog.current?.showModal(); }, [action]);
  useEffect(() => {
    if (!dirty && !saving && !protocolDirty && !chart.trim()) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty, saving, protocolDirty, chart]);
  useEffect(() => () => searchController.current?.abort(), []);
  const navigate = (next: string) => {
    if (next === tab) return;
    if (saving) { setError("正在保存，请完成后再切换页面。"); return; }
    const leave=()=>{setDirty(false);setTab(next);void refresh().catch(e=>setError(e.message));};
    if (dirty) { askAction({ title: "有未保存的修改", detail: "离开将丢弃这条记录尚未保存的修改。选择取消可继续编辑和保存。", run: leave }); return; }
    leave();
  };
  const task = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const open = (r: any) => {
    current.current = r;
    setDirty(false);
    setSelected(r);
    setSeed({ ...r.run, id: r.id,calculation:r.calculation });
    setGeneration((x) => x + 1);
    setTab("record");
  };
  const create = async (p: any) => {
    let r = await api("record_create", {
      protocolId: p.id,
      protocolVersion: p.version,
      requestId: request(),
    });
    if(p.calculationBinding)r=await api('record_bind_engine',{id:r.id,expectedRevision:r.revision,packageId:p.calculationBinding.packageId,version:p.calculationBinding.version,requestId:request()});
    await refresh();
    open(r);
  };
  const saved = async (run: any) => {
    const r = current.current;
    const updated = await api("record_update", {
      id: r.id,
      expectedRevision: r.revision,
      requestId: request(),
      run,
    });
    current.current = updated;
    setSelected(updated);
    await refresh();
    return updated;
  };
  const adapter = {
    automatic:selected?.calculationBinding,
    save: async (run: any) => {const r=await saved(run);return {...r.run,calculation:r.calculation};},
    submit: async (run: any) => {
      const r = await saved(run);
      const updated = await api("record_submit", {
        id: r.id,
        expectedRevision: r.revision,
        requestId: request(),
      });
      current.current = updated;
      setSelected(updated);
      await refresh();
      return updated.run;
    },
    create: async () => {
      const r = current.current;
      await create({ id: r.protocolId, version: r.protocolVersion,calculationBinding:r.calculationBinding });
    },
    export: async () => {
      if (dirty || saving) throw new Error("请先保存草稿，再导出服务器记录。");
      const data = await api("record_export", { id: current.current.id });
      await downloadTextContent(
        JSON.stringify(data, null, 2),
        current.current.id + ".record.json",
        "application/json",
      );
    },
  };
  const openInteractive=async(pack:any)=>{
    const source=await api('engine_package_get',{id:pack.id,version:pack.version});
    // Another sidebar tab or an interrupted attempt may already have created this version.
    let existing;
    try{existing=await api('protocol_get',{id:pack.id,version:pack.version});}
    catch(error:any){
      if(error.code!=='NOT_FOUND')throw error;
      try{existing=await api('protocol_put',{id:pack.id,version:pack.version,content:source.files['protocol.aimd'],requestId:request()});}
      catch(conflict:any){
        if(conflict.code!=='CONFLICT')throw conflict;
        existing=await api('protocol_get',{id:pack.id,version:pack.version});
      }
    }
    if(existing && existing.content!==source.files['protocol.aimd'])throw new Error('同名协议版本内容不同，请为计算包使用新版本。');
    const r=await api('record_create',{protocolId:pack.id,protocolVersion:pack.version,requestId:request()});
    const bound=await api('record_bind_engine',{id:r.id,expectedRevision:r.revision,packageId:pack.id,version:pack.version,requestId:request()});
    await refresh();open(bound);
  };
  if (!state && platformIdentity) return <div className="connect"><div className="brandmark"><Flask size={32} aria-hidden="true" /></div><h1>{error ? '科研成果暂时无法载入' : '正在载入科研成果…'}</h1><p>使用当前平台身份，无需单独登录或填写科研密钥。</p>{error && <><p role="alert" className="error">{error}</p><button onClick={() => location.reload()}>重新载入</button></>}</div>;
  if (!state)
    return (
      <div className="connect">
        {returnToConversation}
        <div className="brandmark"><Flask size={32} aria-hidden="true" /></div>
        <small>DEEPSCIENTIST · 科研工作台</small>
        <h1>连接你的研究空间</h1>
        <AccountLogin/>
        <p>
          输入本地 connection.json 中的 humanToken。连接后使用本地 HttpOnly
          会话，密钥不写入浏览器存储。
        </p>
        <input
          type="password"
          aria-label="工作台访问密钥"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="本地工作台访问密钥"
        />
        <button
          onClick={() =>
            void task(async () => {
              setState(await api("state", { includeArchived: true }, key));
              setKey("");
            })
          }
        >
          连接工作台
        </button>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
      </div>
    );
  const p =
    selected &&
    state.protocols.find(
      (x: any) =>
        x.id === selected.protocolId && x.version === selected.protocolVersion,
    );
  const visibleRecords = state.records.filter((r: any) => Boolean(r.archived) === showArchived && (r.protocolId + " " + r.id).toLowerCase().includes(recordQuery.toLowerCase()));
  return (
    <div className="shell">
      <aside>
        <div className="wordmark">
          <Flask size={23} strokeWidth={1.7} aria-hidden="true" />
          <div><strong>DeepScientist</strong><small>科研工作台</small></div>
        </div>
        <div className="workspace-name">
          <i /> {sessionId ? '当前对话研究空间' : '历史研究空间'} <small>Airalogy 辅助记录与归档</small>
        </div>
        <nav aria-label="科研工作台导航">
          {visibleNavigation.map(([id, Icon, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <strong>DeepSeek Harness</strong>
          <span>科学研究模式 · {window.__DS_RESEARCH_PUBLIC__?.cloud ? "当前账号研究空间" : "本地研究空间"}</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          {(!state.access || state.access.user.admin) && returnToConversation}
          <span>
            研究 /{" "}
            {tab === "record"
              ? "实验工作台"
              : (
                  {
                    overview: "总览", deliverables: "对话成果",
                    science: "研究路线与证据", engine:"实验与结果", archives:"导入与归档",
                    protocols: "协议",
                    records: "记录",
                    literature: "文献",
                    artifacts: "图表", access:"账号与项目",
                  } as any
                )[tab]}
          </span>
          <div className="topbar-status">
            <span className="status-dot" /> {sessionId ? '当前对话' : '未关联历史数据'}{" "}
            <button disabled={busy} onClick={() => void task(refresh)}>
              <Refresh size={14} aria-hidden="true" />刷新
            </button>
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {tab === "deliverables" && <ConversationWorkbench />}
        {tab === "archives" && <ArchiveWorkspace />}
        {tab === "access" && <AccessWorkspace/>}
        {tab === "engine" && <EngineWorkspace onDirty={setDirty} onOpenRecord={openInteractive} onResumeRecord={async(r:any)=>{const latest=await api('record_get',{id:r.id});await refresh();open(latest);}} />}
        {tab === "science" && <ScienceWorkspace workspace={state} onDirty={setDirty} />}
        {tab === "overview" && (
          <section className="page overview-page">
            <div className="overview-label"><Flask size={15} aria-hidden="true" />科学研究模式<span>从问题到证据</span></div>
            <h1>DeepScientist 科研工作台</h1>
            <p className="lead">
              在对话中开展调研、实验与分析，在这里整理成果与证据。由 DeepScientist 驱动研究，Airalogy 辅助记录与归档。
            </p>
            <div className="stats">
              {[
                ["已固定协议", state.protocols.length, BookOpen],
                ["实验记录", state.records.filter((r: any) => !r.archived).length, Notes],
                [
                  "已提交记录",
                  state.records.filter((r: any) => !r.archived && r.status === "submitted")
                    .length, CheckOne,
                ],
                ["图片与图表", state.artifacts.filter((a: any) => artifactCategory(a) === 'chart').length, ChartHistogram],
              ].map(([label, n, Icon]: any) => (
                <article key={label}>
                  <span>{label}<Icon size={17} strokeWidth={1.6} aria-hidden="true" /></span>
                  <strong>{n}</strong>
                </article>
              ))}
            </div>
            <div className="feature-grid">
              <article className="feature feature-primary">
                <div className="feature-label"><span className="feature-icon"><FolderOpen size={21} strokeWidth={1.6} aria-hidden="true" /></span><span>DeepScientist · 研究成果</span></div>
                <h2>查看本次研究的文件与图表</h2>
                <p>
                  对话中完成并交付的文件、图片与科研图表集中展示，可预览、下载，并按对话分别保存。
                </p>
                <button className="primary" onClick={() => navigate("deliverables")}>
                  查看研究成果<ArrowRight size={15} aria-hidden="true" />
                </button>
              </article>
              <article className="feature">
                <div className="feature-label"><span className="feature-icon"><FileText size={21} strokeWidth={1.6} aria-hidden="true" /></span><span>Airalogy · 辅助记录</span></div>
                <h2>保存过程，复核实验记录</h2>
                <p>
                  用协议整理研究方法，用结构化记录保存实验过程。提交前由人工复核，成果可按 Airalogy 格式归档。
                </p>
                <button onClick={() => navigate("records")}>
                  进入实验记录<ArrowRight size={15} aria-hidden="true" />
                </button>
              </article>
            </div>
            <div className="note">
              当前成果按对话分别保存。研究路线、方法与实验记录，都可以从上方导航继续查看。
            </div>
          </section>
        )}
        {tab === "protocols" && (
          <section className="page">
            <div className="eyebrow">PROTOCOL LIBRARY</div>
            <h1>协议与方法</h1>
            <div className="interactive-intro"><strong>填写数据，查看结果</strong><p>在“实验与结果”选择实验方法，或继续填写已有实验。修改输入后自动计算、保存并更新图表。</p><button onClick={()=>navigate('engine')}>前往实验与结果 →</button></div>
            <div className="columns">
              <div>
                <h2>固定一个新版本</h2>
                <label>
                  协议 ID
                  <input
                    aria-label="协议 ID"
                    value={protocolId}
                  onChange={(e) => { setProtocolId(e.target.value); setProtocolDirty(true); }}
                  />
                </label>
                <label>
                  版本
                  <input
                    aria-label="版本"
                    value={version}
                    onChange={(e) => { setVersion(e.target.value); setProtocolDirty(true); }}
                  />
                </label>
                <label>
                  AIMD 源码
                  <textarea
                    aria-label="AIMD 源码"
                    className="code"
                    rows={18}
                    value={source}
                    onChange={(e) => { setSource(e.target.value); setProtocolDirty(true); }}
                  />
                </label>
                <input
                  type="file"
                  accept=".aimd,.md"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void f.text().then(content => { setSource(content); setProtocolDirty(true); });
                  }}
                />
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      await api("protocol_put", {
                        id: protocolId,
                        version,
                        content: source,
                        requestId: request(),
                      });
                      setProtocolDirty(false);
                      await refresh();
                    })
                  }
                >
                  保存协议版本
                </button>
              </div>
              <div>
                <h2>版本库</h2>
                {state.protocols.map((p: any) => (
                  <article className="card" key={p.id + p.version}>
                    <span className="badge">{p.version}</span>
                    <h3>{p.title}</h3>
                    <p>{p.id}</p>
                    <small>SHA-256 {p.sha256.slice(0, 12)}</small>
                    <button onClick={() => void task(() => create(p))}>
                      新建实验记录 →
                    </button>
                    <button
                      onClick={() => setPreview(p)}
                    >
                      查看源码
                    </button>
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}
        {tab === "records" && (
          <section className="page">
            <div className="eyebrow">RESEARCH RECORDS</div>
            <h1>实验记录</h1>
            <p className="lead">
              每次提交保留历史；修改已提交记录需要填写原因。
            </p>
            <div className="search">
              <input aria-label="搜索实验记录" placeholder="搜索协议 ID 或记录 ID" value={recordQuery} onChange={e => setRecordQuery(e.target.value)} />
              <button aria-pressed={showArchived} onClick={() => setShowArchived(x => !x)}>{showArchived ? "返回实验记录" : "打开归档箱"}</button>
            </div>
            {showArchived && <h2>归档箱</h2>}
            {!visibleRecords.length && (
              <div className="empty">
                {showArchived ? "暂无归档记录。" : "没有符合条件的记录，可从协议库新建。"}
                <button onClick={() => setTab("protocols")}>打开协议库</button>
              </div>
            )}
            {visibleRecords.map((r: any) => (
              <article className="record-row" key={r.id}>
                <div>
                  <span className="badge">
                    {r.status === "submitted" ? "已提交" : "草稿"}
                  </span>
                  <h3>
                    {r.protocolId} <small>v{r.protocolVersion}</small>
                  </h3>
                  <code>{r.id}</code>
                </div>
                <div>
                  <small>修订 {r.revision}</small>
                  {!r.archived && <button onClick={() => open(r)}>打开工作台</button>}
                  <button
                    disabled={busy}
                    onClick={() =>
                      askAction({ title: r.archived ? "恢复记录" : "归档记录", detail: r.archived ? "恢复后记录将重新出现在实验记录列表，历史保持完整。" : "归档保留全部历史，之后可以在归档箱恢复。", reason: true, run: async (reason) => {
                          await api(r.archived ? "record_restore" : "record_archive", {
                            id: r.id,
                            expectedRevision: r.revision,
                            reason,
                            requestId: request(),
                          });
                          await refresh();
                      } })
                    }
                  >
                    {r.archived ? "恢复记录" : "归档"}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
        {tab === "record" && p && (
          <>
            <TaskRecordLink record={selected} onBack={()=>navigate('engine')}/>
            <div className="record-toolbar">
              {selected.calculationBinding && <button disabled={saving} onClick={()=>navigate('engine')}><ArrowLeft size={14} aria-hidden="true"/>返回实验与结果</button>}
              <span>
                记录 {selected.id.slice(0, 8)} · 修订 {selected.revision}
              </span>
              <button
                disabled={saving}
                onClick={() =>
                  askAction({ title: "重新载入服务器版本", detail: "重新载入会丢弃这条记录尚未保存的修改。", run: async () => open(await api("record_get", { id: selected.id })) })
                }
              >
                重新载入服务器版本
              </button>
              {selected.status === "submitted" && (
                <button
                  onClick={() =>
                    askAction({ title: "修订已提交记录", detail: "将保留此前提交的快照，修订后需要再次人工复核并提交。", reason: true, run: async (reason) => {
                        const r = await api("record_reopen", {
                          id: selected.id,
                          expectedRevision: selected.revision,
                          reason,
                          requestId: request(),
                        });
                        await refresh();
                        open(r);
                    } })
                  }
                >
                  修订已提交记录
                </button>
              )}
            </div>
            <RecordCalculationSetup record={selected} disabled={dirty||saving} onBound={async(r:any)=>{await refresh();open(r);}}/>
            {new URLSearchParams(location.search).get('review')==='1'&&selected.status==='draft'&&<div className="record-review-hint" role="status"><strong>请人工复核这条记录</strong><p>先核对下方记录与来源，完成标注为人工检查的项目，再点击“保存草稿”和“完成运行”。提交后会保存可复核的记录快照。</p></div>}
            <Workspace
              key={selected.id + ":" + generation}
              content={p.content}
              filePath={'protocol:'+p.id+'@'+p.version}
              revision={p.version}
              initialRun={seed}
              adapter={adapter}
              onDirtyChange={setDirty}
              onBusyChange={setSaving}
            />
            <details className="audit">
              <summary>服务端审计记录</summary>
              <pre>{JSON.stringify(selected.audit, null, 2)}</pre>
            </details>
          </>
        )}
        {tab === "literature" && <DocumentIndex workspace={state}/>}
        {tab === "literature" && (
          <section className="page">
            <div className="eyebrow">EVIDENCE DISCOVERY</div>
            <h1>检索研究线索</h1>
            <p className="lead">
              可检索本对话的文本资料和研究档案，也可连接文献数据库。候选条目仍需核验原文和具体结论。
            </p>
            <div className="search">
              <input
                aria-label="文献关键词"
                disabled={busy}
                value={query}
                onChange={(e) => {setQuery(e.target.value);setPapers(null);}}
                placeholder="输入论文主题或关键词"
              />
              <button
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    setPapers(null);
                    searchController.current = new AbortController();
                    try { setPapers(
                      await api(literatureSource==='local'?'local_search':"literature_search", {
                        query,
                        ...(literatureSource==='local'?{}:{source:literatureSource}),
                        max_results: maxResults,
                      }, undefined, searchController.current.signal),
                    ); } catch (e: any) { if (e.name === "AbortError") setError("已取消检索"); else throw e; }
                    finally { searchController.current = null; }
                  })
                }
              >
                {searchController.current ? "检索中…" : "检索文献"}
              </button>
              {searchController.current && <button onClick={() => searchController.current?.abort()}>取消检索</button>}
            </div>
            <div className="search">
              <label>文献来源<select aria-label="文献来源" disabled={busy} value={literatureSource} onChange={e => {setLiteratureSource(e.target.value);setPapers(null);}}>{["local", "crossref", "openalex", "semantic_scholar", "arxiv", "openreview", "dblp"].map(source => <option key={source} value={source}>{source==='local'?'本对话资料（离线）':source+'（在线）'}</option>)}</select></label>
              <label>结果数量<input aria-label="结果数量" disabled={busy} type="number" min="1" max="20" value={maxResults} onChange={e => setMaxResults(Number(e.target.value))} /></label>
            </div>
            {literatureSource!=='local'&&<p className="science-muted">在线检索需要连接所选数据库，服务可能限流或要求验证。无外网时请选择“本对话资料（离线）”。</p>}
            {papers && (
              <div className="science-workspace">{papers.scope==='current-conversation'?<><p>{papers.totalMatches} 条匹配 · {papers.note}</p>{papers.results.map((r:any,i:number)=><article className="science-card" key={i}><h2>{r.title}</h2><p>{r.excerpt}</p><small>{r.kind} · {r.reference || r.id} {r.revision?'· v'+r.revision:''} {r.page?'· 第 '+r.page+' 页':''} {r.method==='ocr'?'· OCR 识别，需核对':''}</small></article>)}{papers.skipped.length>0 && <details><summary>{papers.skipped.length} 个文件未参与本次文本检索</summary><p>{papers.skipped.join('、')}</p></details>}</>:<>{papers.papers?.map((p:any,i:number)=><article className="science-card" key={i}><h2>{p.title}</h2><p>{p.abstract}</p>{p.url && /^https?:/.test(p.url) && <a href={p.url} target="_blank" rel="noreferrer">查看原始来源</a>}</article>)}<details><summary>来源状态与原始检索结果</summary><pre>{JSON.stringify(papers,null,2)}</pre></details></>}</div>
            )}
          </section>
        )}
        {tab === "artifacts" && (
          <section className="page">
            <div className="eyebrow">SCIENTIFIC FIGURES</div>
            <h1>让证据清晰可见</h1>
            <p className="lead">复用 V2 图表规范、场景编译和 SVG 渲染器。</p>
            <details>
              <summary>从 report_chart v1/v2 JSON 生成图表</summary>
              <textarea
                className="code"
                rows={12}
                value={chart}
                onChange={(e) => setChart(e.target.value)}
                placeholder="粘贴 DeepScientist report_chart JSON"
              />
              <button
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    await api("chart_render", {
                      spec: JSON.parse(chart),
                      requestId: request(),
                    });
                    setChart("");
                    await refresh();
                  })
                }
              >
                验证并生成
              </button>
            </details>
            {state.artifacts.filter((a: any) => a.kind === 'chart').map((a: any) => (
              <article className="card" key={a.id}>
                <h2>{a.title}</h2>
                {embedded&&<button onClick={()=>openWorkbench({view:'detail',kind:'chart',item:a.id,title:a.title})}>查看详情</button>}
                <img
                  className="chart"
                  src={
                    "data:image/svg+xml;base64," +
                    btoa(unescape(encodeURIComponent(a.svg)))
                  }
                  alt={a.title}
                />
                <button
                  onClick={() =>
                    void downloadTextContent(
                      a.svg,
                      a.id + ".svg",
                      "image/svg+xml",
                    )
                  }
                >
                  下载 SVG
                </button>
              </article>
            ))}
          </section>
        )}
        <footer>
          DeepScientist 科研工作台 · Airalogy 辅助记录与归档
        </footer>
      </main>
      {preview && <dialog ref={previewDialog} className="document-preview" onClose={() => setPreview(null)}>
        <h2>{preview.title}</h2><p>{preview.id}{preview.version?' · 版本 '+preview.version:''}</p>
        <pre>{preview.content}</pre>
        <button autoFocus onClick={() => previewDialog.current?.close()}>关闭预览</button>
      </dialog>}
      {action && <dialog ref={actionDialog} className="document-preview" aria-labelledby="action-title" onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => setAction(null)}>
        <form onSubmit={event => { event.preventDefault(); if (busy || (action.reason && !reason.trim())) return; setBusy(true); setActionError(""); void Promise.resolve().then(() => action.run(reason.trim())).then(() => setAction(null)).catch(e => setActionError(e.message)).finally(() => setBusy(false)); }}>
          <h2 id="action-title">{action.title}</h2><p>{action.detail}</p>
          {action.reason && <label>操作原因<input autoFocus required aria-label="操作原因" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>}
          {actionError && <p role="alert" className="error">{actionError}</p>}
          <button type="button" autoFocus={!action.reason} disabled={busy} onClick={() => actionDialog.current?.close()}>取消</button>{" "}
          <button type="submit" disabled={busy || (action.reason && !reason.trim())}>{busy ? "处理中…" : "确认"}</button>
        </form>
      </dialog>}
    </div>
  );
}
const compactView = ['compact','detail'].includes(new URLSearchParams(location.search).get('view') || '');
if (compactView) document.documentElement.dataset.researchCompact = '';
if (embedded) document.documentElement.dataset.researchEmbedded = '';
createRoot(document.getElementById("root")!).render(compactView ? <ConversationWorkbench /> : <App />);
