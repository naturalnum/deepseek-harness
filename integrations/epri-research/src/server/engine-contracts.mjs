import {z} from 'zod';
const id=z.string().regex(/^[\w.-]{1,120}$/);
const object=z.record(z.unknown());
export const engineContracts={
  engine_status:{description:'Check the installed Airalogy runtime. Native Windows mode uses the current user permissions; Docker mode disables network. Read execution/network fields before describing isolation.',shape:{}},
  engine_packages:{description:'List immutable protocol/workflow packages in this conversation.',shape:{}},
  engine_package_get:{description:'Read a package, including source files, hash and execution approval.',shape:{id,version:id}},
  engine_package_put:{description:'Human-only: import source files for an immutable Airalogy protocol/workflow package. Approve separately after source review.',shape:{id,version:id,title:z.string().trim().min(1).max(200),kind:z.enum(['protocol','workflow']),files:z.record(z.union([z.string(),z.object({contentBase64:z.string()}).strict()])),requestId:id}},
  engine_package_review:{description:'Human-only: approve or revoke execution of this exact package hash.',shape:{id,version:id,sha256:z.string().regex(/^[a-f0-9]{64}$/),approved:z.boolean(),reason:z.string().trim().min(1).max(2000)}},
  engine_run:{description:'Start a persisted Airalogy execution using an approved package. Returns immediately; poll engine_run_get. Outputs are drafts and do not silently modify reviewed records. Protocol actions use original Python executor; workflows use original transition engine.',shape:{packageId:id,version:id,action:z.enum(['parse_protocol','validate_variables','assign_variable','recalculate','import_records','migrate_schema','workflow','workflow_transition']),params:object,attachments:z.record(z.string().regex(/^attachment:[a-f0-9]{64}$/)).default({}),requestId:id}},
  engine_run_get:{description:'Read execution status, exact inputs, package hash and outputs.',shape:{id}},
  engine_runs:{description:'List recent execution runs for this conversation.',shape:{}},
  engine_cancel:{description:'Cancel an active execution in this conversation.',shape:{id}},
};
