import React, { useEffect, useRef, useState } from 'react';
import { api, sessionId } from './adapters/api';
import { downloadTextContent } from './adapters/download';
import { interactiveExample } from './interactive-example';
import { parseAimdProtocol } from '../reused/protocol/aimdProtocolModel';
import ResearchTasks from './ResearchTasks';
const uid = () => crypto.randomUUID();
const labels: any = {
  recalculate: '表格自动计算',
  parse_protocol: '解析协议',
  validate_variables: '校验变量',
  assign_variable: '自动赋值',
  import_records: '解析外部记录',
  migrate_schema: '迁移记录结构',
  workflow: '运行工作流',
  workflow_transition: '执行单个流转',
  needs_review: '需要复核',
  running: '运行中',
  succeeded: '执行成功',
  validation_failed: '校验未通过',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '服务中断',
  timed_out: '执行超时',
};
const example: any = {
  parse_protocol: {},
  validate_variables: { seconds: 120 },
  assign_variable: { var_name: 'duration', dependent_data: { seconds: 120 } },
  import_records: {},
  migrate_schema: {},
  workflow: { records: {}, maxPasses: 1 },
  workflow_transition: { records: {}, transitionId: '' },
};
export default function EngineWorkspace({ onDirty, onOpenRecord, onResumeRecord }: any) {
  const [workspace, setWorkspace] = useState<any>({ protocols: [], records: [] });
  const [status, setStatus] = useState<any>(null),
    [packages, setPackages] = useState<any[]>([]),
    [runs, setRuns] = useState<any[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<any>(null),
    [selected, setSelected] = useState(''),
    [action, setAction] = useState('parse_protocol'),
    [params, setParams] = useState('{}'),
    [detail, setDetail] = useState<any>(null),
    [review, setReview] = useState<any>(null),
    [reason, setReason] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = async () => {
    const [p, r, s] = await Promise.all([api('engine_packages'), api('engine_runs'), api('state')]);
    setPackages(p);
    setRuns(r);
    setWorkspace(s);
  };
  const task = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (sessionId) {
      void refresh().catch((e) => setError(e.message));
      void api('engine_status')
        .then(setStatus)
        .catch((e) => setError(e.message));
    }
  }, []);
  const running = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh().catch((e) => setError(e.message)), 1500);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (review) dialog.current?.showModal();
  }, [review]);
  useEffect(() => {
    onDirty(Boolean(draft));
    return () => onDirty(false);
  }, [Boolean(draft)]);
  const selectedPackage = packages.find((p) => p.id + '@' + p.version === selected);
  const inspect = async (p: any) =>
    setReview(await api('engine_package_get', { id: p.id, version: p.version }));
  const records = workspace.records
    .filter((r: any) => r.calculationBinding && !r.archived)
    .sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt));
  const loadExample = () =>
    task(async () => {
      const p = await api('engine_package_put', { ...interactiveExample, requestId: uid() });
      await refresh();
      setReason('');
      await inspect(p);
    });
  const openTable = (p: any) =>
    task(async () => {
      const environment = await api('engine_status');
      setStatus(environment);
      if (!environment.ready)
        throw new Error(
          environment.message || '自动计算环境尚未就绪，请检查运行文件后重试；无需重新载入或审批这个协议。',
        );
      await onOpenRecord(p);
    });
  const resultFields = (r: any) => {
    const p = workspace.protocols.find((p: any) => p.id === r.protocolId && p.version === r.protocolVersion);
    if (!p) return [];
    return parseAimdProtocol(p.content)
      .variables.filter(
        (f) =>
          r.calculationBinding.targets.includes(f.id) &&
          ['number', 'string', 'boolean'].includes(typeof r.run.values[f.id]),
      )
      .slice(0, 3)
      .map((f) => ({
        id: f.id,
        title: String(f.definition?.kwargs?.title || f.id),
        value: String(r.run.values[f.id]),
      }));
  };
  if (!sessionId)
    return (
      <section className="page">
        <h1>协议与工作流执行</h1>
        <p>请从科研对话进入本页面。</p>
      </section>
    );
  return (
    <section className="page science-workspace engine-workspace">
      <div className="science-heading">
        <div>
          <h1>实验与结果</h1>
          <p>继续填写实验，查看自动计算结果与图表。</p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void task(async () => {
              await refresh();
              setStatus(await api('engine_status'));
            })
          }
        >
          刷新状态
        </button>
      </div>
      <div className="experiment-environment" data-ready={Boolean(status?.ready)}>
        <i />
        {status?.ready ? '计算已就绪' : status?.message || '正在检查计算环境…'}
      </div>
      {error && (
        <p role="alert" className="compact-error">
          {error}
        </p>
      )}
      <ResearchTasks onResumeRecord={onResumeRecord}/>
      <details className="legacy-experiments"><summary>方法包维护与独立实验</summary>
      <section className="experiment-next" aria-label="下一步">
        <span>下一步</span>
        <p>
          {records.length
            ? '继续填写已有实验，或查看已保存的结果。'
            : packages.some((p) => p.approved)
              ? '选择下方实验方法，打开表格填写数据。'
              : packages.length
                ? '先审阅实验方法，启用后即可填写表格。'
                : '从示例开始，体验填数据后自动生成结果。'}
        </p>
      </section>
      {records.length > 0 && (
        <section className="experiment-section" aria-label="最近实验">
          <header>
            <h2>最近实验</h2>
            <small>输入、结果和图表一起保存</small>
          </header>
          {records.slice(0, 5).map((r: any) => {
            const p = workspace.protocols.find(
                (p: any) => p.id === r.protocolId && p.version === r.protocolVersion,
              ),
              hasErrors = r.calculation?.errors?.length,
              pending = r.calculation?.pending?.length,
              state =
                r.status === 'submitted'
                  ? '已完成复核'
                  : hasErrors
                    ? '需要修正数据'
                    : pending || !r.calculation
                      ? '等待填写数据'
                      : '已计算 · 待复核';
            return (
              <article key={r.id} className="experiment-record">
                <div className="experiment-record-heading">
                  <div>
                    <h3>{p?.title || r.protocolId}</h3>
                    <small>
                      {new Date(r.updatedAt).toLocaleString()} · {state}
                    </small>
                  </div>
                  <button
                    className="experiment-primary"
                    disabled={busy}
                    onClick={() => void task(() => onResumeRecord(r))}
                  >
                    {r.status === 'submitted' ? '查看结果' : '继续填写'}
                  </button>
                </div>
                <dl className="experiment-metrics">
                  {resultFields(r).map((f) => (
                    <div key={f.id}>
                      <dt>{f.title}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
                {hasErrors > 0 && <p className="experiment-problem">{r.calculation.errors[0].message}</p>}
              </article>
            );
          })}
        </section>
      )}
      <section className="experiment-section" aria-label="实验方法">
        <header>
          <h2>{records.length ? '开始新实验' : '选择实验方法'}</h2>
          <button
            disabled={busy || Boolean(draft)}
            onClick={() => setDraft({ id: '', version: '1.0.0', title: '', kind: 'protocol', files: {} })}
          >
            ＋ 导入方法
          </button>
        </header>
        {!packages.length && !draft && (
          <div className="experiment-empty">
            <strong>还没有实验方法</strong>
            <p>先用设备测点示例试一试：填写采样数量，自动查看缺失率和对比图。</p>
            <button className="experiment-primary" disabled={busy} onClick={() => void loadExample()}>
              载入设备数据质量示例
            </button>
          </div>
        )}
        {draft && (
          <form
            className="science-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void task(async () => {
                const p = await api('engine_package_put', { ...draft, requestId: uid() });
                setDraft(null);
                await refresh();
                setSelected(p.id + '@' + p.version);
                const next = p.kind === 'workflow' ? 'workflow' : 'parse_protocol';
                setAction(next);
                setParams(JSON.stringify(example[next], null, 2));
                await inspect(p);
              });
            }}
          >
            <h2>导入源文件</h2>
            <p>
              选择文件夹会读取其中的文件；协议需要 protocol.aimd、protocol.toml，工作流需要
              workflow.aimd。导入后可查看源码并批准运行。
            </p>
            <div className="science-form-row">
              <label>
                标识
                <input
                  required
                  pattern="[\w.\-]+"
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </label>
              <label>
                版本
                <input
                  required
                  pattern="[\w.\-]+"
                  value={draft.version}
                  onChange={(e) => setDraft({ ...draft, version: e.target.value })}
                />
              </label>
            </div>
            <label>
              名称
              <input
                required
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label>
              类型
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                <option value="protocol">实验协议</option>
                <option value="workflow">多节点工作流</option>
              </select>
            </label>
            <label>
              选择源文件夹
              <input
                type="file"
                multiple
                {...({ webkitdirectory: '' } as any)}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  void task(async () => {
                    if (files.length > 100 || files.reduce((n, f) => n + f.size, 0) > 2 * 1024 * 1024)
                      throw new Error('最多 100 个文件、2 MiB。');
                    const entries = await Promise.all(
                      files.map(async (f) => [
                        (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name,
                        /\.(aimd|toml|py|md|txt|json|csv|yaml|yml|tsv)$/i.test(f.name)
                          ? await f.text()
                          : {
                              contentBase64: await new Promise<string>((resolve, reject) => {
                                const r = new FileReader();
                                r.onload = () => resolve(String(r.result).split(',')[1]);
                                r.onerror = () => reject(new Error('文件读取失败'));
                                r.readAsDataURL(f);
                              }),
                            },
                      ]),
                    );
                    setDraft((d: any) => ({ ...d, files: Object.fromEntries(entries) }));
                  });
                }}
              />
            </label>
            <details>
              <summary>已选择 {Object.keys(draft.files).length} 个文件</summary>
              <pre>{Object.keys(draft.files).join('\n')}</pre>
            </details>
            <div className="science-form-actions">
              <button disabled={busy || !Object.keys(draft.files).length}>保存并查看源码</button>
              <button type="button" onClick={() => setDraft(null)}>
                取消
              </button>
            </div>
          </form>
        )}
        {!draft &&
          packages.map((p) => (
            <article className="experiment-method" key={p.id + '@' + p.version}>
              <div className="experiment-record-heading">
                <div>
                  <h3>{p.title}</h3>
                  <small>
                    {p.kind === 'protocol' ? '实验方法' : '多节点工作流'} ·{' '}
                    {p.approved ? '已启用' : '等待审阅'}
                  </small>
                </div>
                {p.kind === 'protocol' && p.approved ? (
                  <button className="experiment-primary" disabled={busy} onClick={() => void openTable(p)}>
                    打开交互实验表
                  </button>
                ) : (
                  <button
                    className="experiment-primary"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        setReason('');
                        await inspect(p);
                      })
                    }
                  >
                    {p.approved ? '查看方法' : '审阅并启用'}
                  </button>
                )}
              </div>
              <details className="experiment-method-details">
                <summary>方法说明与版本</summary>
                <p>
                  {p.id} · {p.version}
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      setReason('');
                      await inspect(p);
                    })
                  }
                >
                  查看源码与审批
                </button>
              </details>
            </article>
          ))}
      </section>
      <details className="experiment-advanced">
        <summary>高级配置与执行记录</summary>
        <p>维护实验方法、运行单个计算操作，或查看每次执行的技术记录。</p>
        <button disabled={busy} onClick={() => void loadExample()}>
          载入设备数据质量示例
        </button>
        {!draft && (
          <>
            <form
              className="science-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void task(async () => {
                  const input = JSON.parse(params);
                  if (!input || Array.isArray(input) || typeof input !== 'object')
                    throw new Error('输入必须是 JSON 对象。');
                  const run = await api('engine_run', {
                    packageId: selectedPackage.id,
                    version: selectedPackage.version,
                    action,
                    params: input,
                    requestId: uid(),
                  });
                  setDetail(run);
                  await refresh();
                });
              }}
            >
              <h2>开始一次执行</h2>
              <label>
                协议版本
                <select
                  required
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    const p = packages.find((p) => p.id + '@' + p.version === e.target.value);
                    const next = p?.kind === 'workflow' ? 'workflow' : 'parse_protocol';
                    setAction(next);
                    setParams(JSON.stringify(example[next], null, 2));
                  }}
                >
                  <option value="">请选择已批准的版本</option>
                  {packages.map((p) => (
                    <option key={p.id + '@' + p.version} value={p.id + '@' + p.version}>
                      {p.title} · {p.version}
                      {p.approved ? '' : '（待批准）'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                操作
                <select
                  value={action}
                  onChange={(e) => {
                    setAction(e.target.value);
                    setParams(JSON.stringify(example[e.target.value], null, 2));
                  }}
                >
                  {(selectedPackage?.kind === 'workflow'
                    ? ['workflow', 'workflow_transition']
                    : [
                        'parse_protocol',
                        'validate_variables',
                        'assign_variable',
                        'import_records',
                        'migrate_schema',
                      ]
                  ).map((x) => (
                    <option key={x} value={x}>
                      {labels[x]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                输入数据（JSON）
                <textarea required rows={8} value={params} onChange={(e) => setParams(e.target.value)} />
              </label>
              <p className="science-muted">运行结果先保存为独立记录。查看并确认后，可另存到本对话成果中。</p>
              <button disabled={busy || !status?.ready || !selectedPackage?.approved}>运行并保存结果</button>
            </form>
            <div className="science-card">
              <h2>执行历史</h2>
              {!runs.length && <p>每次执行会保留状态、输入、输出及源码指纹。</p>}
              {runs.map((r) => (
                <div className="engine-run" key={r.id}>
                  <div>
                    <strong>
                      {labels[r.action]} · {r.packageId}
                    </strong>
                    <p>
                      {labels[r.status]} · {new Date(r.startedAt).toLocaleString()}
                    </p>
                    {r.error && <p role="alert">{r.error}</p>}
                  </div>
                  <div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void task(async () => setDetail(await api('engine_run_get', { id: r.id })))
                      }
                    >
                      查看结果
                    </button>
                    {r.status === 'running' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void task(async () => {
                            await api('engine_cancel', { id: r.id });
                            await refresh();
                          })
                        }
                      >
                        停止
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {detail && (
              <article className="science-card">
                <header>
                  <h2>执行详情 · {labels[detail.status]}</h2>
                  <button onClick={() => setDetail(null)}>收起</button>
                </header>
                <p>
                  {detail.packageId} · {detail.version}
                </p>
                {detail.result?.data?.assigned_fields && (
                  <dl className="engine-values">
                    {Object.entries(detail.result.data.assigned_fields).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {detail.result?.data?.errors?.length > 0 && (
                  <ul>
                    {detail.result.data.errors.map((e: any, i: number) => (
                      <li key={i}>
                        {e.loc?.join('.')}：{e.msg}
                      </li>
                    ))}
                  </ul>
                )}
                {detail.result?.data?.executed_transitions && (
                  <p>已完成 {detail.result.data.executed_transitions.length} 次节点流转；等待记录复核。</p>
                )}
                {detail.status === 'running' && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void task(async () => setDetail(await api('engine_run_get', { id: detail.id })))
                    }
                  >
                    刷新结果
                  </button>
                )}
                <details>
                  <summary>查看输入、输出与源码指纹</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        ...detail,
                        result: detail.result
                          ? {
                              ...detail.result,
                              files: detail.result.files?.map(({ contentBase64, ...f }: any) => ({
                                ...f,
                                size: Math.floor((contentBase64.length * 3) / 4),
                              })),
                            }
                          : undefined,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                {detail.result?.files?.length > 0 && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        const result = await api('engine_outputs_save', {
                          id: detail.id,
                          requestId: 'files-' + detail.id,
                        });
                        setError('已将 ' + result.files.length + ' 个生成文件保存到本对话成果。');
                      })
                    }
                  >
                    保存生成文件（{detail.result.files.length}）
                  </button>
                )}
                <div className="science-form-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void task(() =>
                        downloadTextContent(
                          JSON.stringify(detail, null, 2),
                          'airalogy-run-' + detail.id + '.json',
                          'application/json',
                        ),
                      )
                    }
                  >
                    下载运行记录
                  </button>
                  <button
                    disabled={busy || detail.status === 'running'}
                    onClick={() =>
                      void task(async () => {
                        const bytes = new TextEncoder().encode(JSON.stringify(detail, null, 2));
                        let binary = '';
                        for (const b of bytes) binary += String.fromCharCode(b);
                        await api('attachment_put', {
                          name: 'airalogy-run-' + detail.id + '.json',
                          contentBase64: btoa(binary),
                          requestId: 'run-export-' + detail.id,
                        });
                        setError('执行结果已保存到本对话成果，可在证据页面引用。');
                      })
                    }
                  >
                    保存到本对话成果
                  </button>
                </div>
              </article>
            )}
          </>
        )}
      </details>
      {review && (
        <dialog
          ref={dialog}
          className="science-review engine-review"
          aria-label="审阅协议源码"
          onCancel={(e) => {
            if (busy) e.preventDefault();
            else setReview(null);
          }}
        >
          <h2>
            {review.title} · {review.version}
          </h2>
          <p>源码指纹：{review.sha256}</p>
          {Object.entries(review.files).map(([name, content]) => (
            <details key={name}>
              <summary>{name}</summary>
              <pre>{typeof content === 'string' ? content : '二进制资源（原始字节保留）'}</pre>
            </details>
          ))}
          <p>{status?.execution==='native'?'方法以当前 Windows 用户权限运行。请审阅源码，只启用可信的方法；执行支持超时和取消。':'计算在禁用网络的容器内进行。请核对协议内容后批准执行。'}</p>
          <label>
            审阅意见
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            disabled={busy || !reason.trim()}
            onClick={() =>
              void task(async () => {
                await api('engine_package_review', {
                  id: review.id,
                  version: review.version,
                  sha256: review.sha256,
                  approved: !review.approved,
                  reason,
                });
                setReview(null);
                await refresh();
              })
            }
          >
            {review.approved ? '撤销执行批准' : '批准此版本执行'}
          </button>
          <button disabled={busy} onClick={() => setReview(null)}>
            关闭
          </button>
        </dialog>
      )}
      </details>
    </section>
  );
}
