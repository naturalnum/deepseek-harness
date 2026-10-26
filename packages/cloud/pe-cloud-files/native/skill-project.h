/* Same-owner, fixed two-file writable project publication; no arbitrary names or recursive cleanup. */
static int project_skill_directory(int fd, uid_t uid, gid_t gid, dev_t device, uint64_t mount, struct stat *out) {
  if (fstat(fd,out)) return errno;
  if (!S_ISDIR(out->st_mode) || out->st_uid!=uid || out->st_gid!=gid || (out->st_mode & 07777)!=0700
    || out->st_dev!=device) return EPERM;
  return mount_identity(fd,mount);
}

static int project_skill_contents(int directory, const char *name, const unsigned char *bytes, size_t length,
  uid_t uid, gid_t gid, dev_t device, uint64_t mount, int *close_failed) {
  int fd=skill_open(directory,name,O_RDONLY),error=0;
  struct stat before,after;
  unsigned char block[65536];
  if (fd<0) return errno;
  if (fstat(fd,&before)) error=errno;
  else if (!S_ISREG(before.st_mode) || before.st_nlink!=1 || before.st_uid!=uid || before.st_gid!=gid
    || (before.st_mode & 07777)!=0600 || before.st_dev!=device || before.st_size<0 || (uint64_t)before.st_size!=length) error=ESTALE;
  if (!error) error=mount_identity(fd,mount);
  size_t offset=0;
  while (!error && offset<length) {
    size_t size=length-offset; if (size>sizeof(block)) size=sizeof(block);
    ssize_t got=read(fd,block,size);
    if (got<0 && errno==EINTR) continue;
    if (got<=0) { error=got<0 ? errno : ESTALE; break; }
    if (memcmp(bytes+offset,block,(size_t)got)) { error=ESTALE; break; }
    offset+=(size_t)got;
  }
  if (!error) { ssize_t got; do { got=read(fd,block,1); } while (got<0 && errno==EINTR); if (got!=0) error=got<0 ? errno : ESTALE; }
  if (!error && fstat(fd,&after)) error=errno;
  if (!error && (before.st_dev!=after.st_dev || before.st_ino!=after.st_ino || before.st_size!=after.st_size
    || before.st_mtim.tv_sec!=after.st_mtim.tv_sec || before.st_mtim.tv_nsec!=after.st_mtim.tv_nsec
    || before.st_ctim.tv_sec!=after.st_ctim.tv_sec || before.st_ctim.tv_nsec!=after.st_ctim.tv_nsec)) error=ESTALE;
  if (close(fd)) *close_failed=1;
  return error;
}

static int project_skill_write(int directory, const char *name, const void *bytes, size_t length, int *close_failed) {
  int fd=openat(directory,name,O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600),error=0;
  if (fd<0) return errno;
  size_t offset=0;
  while (offset<length) {
    ssize_t size=write(fd,(const char *)bytes+offset,length-offset);
    if (size<0 && errno==EINTR) continue;
    if (size<=0) { error=size<0 ? errno : EIO; break; }
    offset+=(size_t)size;
  }
  if (!error && fchmod(fd,0600)) error=errno;
  if (!error && fsync(fd)) error=errno;
  if (close(fd)) *close_failed=1;
  return error;
}

static int project_skill_entries(int fd, uint32_t maximum, int versions, uint32_t *count, int *close_failed) {
  int copy=skill_open(fd,".",O_RDONLY | O_DIRECTORY),error=0;
  if (copy<0) return errno;
  DIR *directory=fdopendir(copy);
  if (!directory) { error=errno; if (close(copy)) *close_failed=1; return error; }
  unsigned seen=0;
  for (;;) {
    errno=0; struct dirent *entry=readdir(directory);
    if (!entry) { error=errno; break; }
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    if (versions) {
      if (!skill_uuid(entry->d_name) || entry->d_name[14]!='4' || !strchr("89ab",entry->d_name[19])) { error=EPERM; break; }
      if (*count>=maximum) { error=EFBIG; break; }
      (*count)++;
    } else if (!strcmp(entry->d_name,"SKILL.md")) seen|=1;
    else if (!strcmp(entry->d_name,"resource.bin")) seen|=2;
    else { error=ESTALE; break; }
  }
  if (!error && !versions && seen!=3) error=ESTALE;
  if (closedir(directory)) *close_failed=1;
  return error;
}

static napi_value project_skill_version(napi_env env, napi_callback_info info) {
  napi_value args[20],array,backing,buffer;
  size_t argc=20,offset=0,body_length=0,resource_length=0,cancel_length=0;
  void *memory=NULL,*body=NULL,*resource=NULL,*cancel_data=NULL;
  napi_typedarray_type type;
  owned_fds *owned=state(env);
  if (!owned || owned->anchor>=0 || owned->reader>=0) return fail(env,EBUSY);
  if (napi_create_arraybuffer(env,192,&memory,&backing)!=napi_ok
    || napi_create_typedarray(env,napi_uint8_array,192,backing,0,&array)!=napi_ok) return fail(env,ENOMEM);
  unsigned char *frame=memory;
  memset(frame,0,192); memcpy(frame,"DSP1",4); frame[4]=1;
  uint64_t device=0,inode=0,mount=0,metadata_device=0,metadata_inode=0,metadata_mount=0,start=0,expected_copy=0;
  uint32_t uid=0,gid=0,maximum=0,max_file=0,timeout=0,max_path=0,count=0;
  int error=EINVAL,close_failed=0,changed=0,metadata=-1,skills=-1,version=-1,named=-1,reused=0;
  unsigned flags=0;
  char *path=NULL,*id=NULL; char temporary[48];
  struct stat root,meta,container,created,observed; struct statfs filesystem;
  if (napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=20
    || !bounded_decimal(env,args[1],&device) || !bounded_decimal(env,args[2],&inode)
    || !bounded_decimal(env,args[3],&mount) || !mount
    || !content_number(env,args[4],&uid) || !uid || !content_number(env,args[5],&gid) || !gid
    || !content_number(env,args[9],&maximum) || !maximum || maximum>65536
    || !content_number(env,args[12],&max_file) || !max_file || !content_number(env,args[13],&timeout) || !timeout
    || !content_number(env,args[15],&max_path) || max_path>16384
    || !bounded_decimal(env,args[16],&metadata_device) || !bounded_decimal(env,args[17],&metadata_inode)
    || !bounded_decimal(env,args[18],&metadata_mount) || metadata_device!=device || metadata_mount!=mount
    || !bounded_decimal(env,args[19],&expected_copy)
    || napi_get_typedarray_info(env,args[7],&type,&body_length,&body,&buffer,&offset)!=napi_ok || type!=napi_uint8_array
    || napi_get_typedarray_info(env,args[8],&type,&resource_length,&resource,&buffer,&offset)!=napi_ok || type!=napi_uint8_array
    || napi_get_typedarray_info(env,args[14],&type,&cancel_length,&cancel_data,&buffer,&offset)!=napi_ok
    || type!=napi_int32_array || cancel_length!=1 || offset!=0 || !cancel_data) goto finished;
  bool ordinary=false;
  if (napi_is_arraybuffer(env,buffer,&ordinary)!=napi_ok || ordinary) goto finished;
  path=bounded_text(env,args[0],max_path); id=bounded_text(env,args[6],36);
  if (!path || path[0]!='/' || !skill_uuid(id) || id[14]!='4' || !strchr("89ab",id[19]) || strlen(path)+96>max_path) goto finished;
  put64(frame+32,device); put64(frame+40,inode); put64(frame+48,mount);
  if (body_length>max_file || resource_length>max_file) { error=EFBIG; goto finished; }
  if (geteuid()!=uid || getegid()!=gid) { error=EPERM; goto finished; }
  error=content_clock(&start); if (error) goto finished;
  error=content_running(cancel_data,start+(uint64_t)timeout*1000000ULL); if (error) goto finished;
  owned->anchor=open(path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (owned->anchor<0) { error=errno; goto finished; }
  if (fstat(owned->anchor,&root) || fstatfs(owned->anchor,&filesystem)) { error=errno; goto finished; }
  if (root.st_dev!=(dev_t)device || root.st_ino!=(ino_t)inode) { error=ESTALE; goto finished; }
  error=project_skill_directory(owned->anchor,uid,gid,(dev_t)device,mount,&root); if (error) goto finished;
  if (filesystem.f_type!=EXT4_SUPER_MAGIC) { error=EPERM; goto finished; }
  owned->mount_id=mount; flags|=2;
  error=leaf_parent(owned,path,&close_failed); if (error || close_failed) goto finished;
  metadata=skill_open(owned->anchor,".pe",O_RDONLY | O_DIRECTORY);
  if (metadata<0) { error=errno; goto finished; }
  error=project_skill_directory(metadata,uid,gid,(dev_t)device,mount,&meta); if (error) goto finished;
  if (meta.st_ino!=(ino_t)metadata_inode) { error=ESTALE; goto finished; }
  flags|=4;
  put64(frame+56,device); put64(frame+64,(uint64_t)meta.st_ino); put64(frame+72,mount);
  skills=skill_open(metadata,"skills",O_RDONLY | O_DIRECTORY);
  if (skills<0 && errno!=ENOENT) { error=errno; goto finished; }
  if (skills>=0) {
    error=project_skill_directory(skills,uid,gid,(dev_t)device,mount,&container); if (error) goto finished;
    error=project_skill_entries(skills,maximum,1,&count,&close_failed); if (error || close_failed) goto finished;
    version=skill_open(skills,id,O_RDONLY | O_DIRECTORY);
    if (version<0 && errno!=ENOENT) { error=errno; goto finished; }
    if (version>=0) { if (!expected_copy) { error=EEXIST; goto finished; } reused=1; }
  }
  if (!reused && expected_copy) { error=ESTALE; goto finished; }
  if (!reused && count>=maximum) { error=EFBIG; goto finished; }
  error=content_running(cancel_data,start+(uint64_t)timeout*1000000ULL); if (error) goto finished;
  if (skills<0) {
    if (mkdirat(metadata,"skills",0700)) { error=errno; goto finished; } changed=1;
    skills=skill_open(metadata,"skills",O_RDONLY | O_DIRECTORY); if (skills<0) { error=errno; goto finished; }
  }
  error=project_skill_directory(skills,uid,gid,(dev_t)device,mount,&container); if (error) goto finished;
  flags|=8;
  put64(frame+80,device); put64(frame+88,(uint64_t)container.st_ino); put64(frame+96,mount);
  if (!reused) {
    snprintf(temporary,sizeof(temporary),".pending-%s",id);
    if (mkdirat(skills,temporary,0700)) { error=errno; goto finished; } changed=1;
    version=skill_open(skills,temporary,O_RDONLY | O_DIRECTORY); if (version<0) { error=errno; goto finished; }
    error=project_skill_write(version,"SKILL.md",body,body_length,&close_failed); if (error || close_failed) goto finished;
    error=project_skill_write(version,"resource.bin",resource,resource_length,&close_failed); if (error || close_failed) goto finished;
    if (fsync(version)) { error=errno; goto finished; }
  }
  error=project_skill_directory(version,uid,gid,(dev_t)device,mount,&created); if (error) goto finished;
  if (reused && (uint64_t)created.st_ino!=expected_copy) { error=ESTALE; goto finished; }
  if (!reused) {
    error=project_skill_entries(version,2,0,&count,&close_failed); if (error || close_failed) goto finished;
    error=project_skill_contents(version,"SKILL.md",body,body_length,uid,gid,(dev_t)device,mount,&close_failed); if (error || close_failed) goto finished;
    error=project_skill_contents(version,"resource.bin",resource,resource_length,uid,gid,(dev_t)device,mount,&close_failed); if (error || close_failed) goto finished;
  }
  flags|=16;
  if (!reused && syscall(SYS_renameat2,skills,temporary,skills,id,RENAME_NOREPLACE)) { error=errno; goto finished; }
  flags|=32;
  if (fsync(version) || fsync(skills) || fsync(metadata) || fsync(owned->anchor)) { error=errno; goto finished; }
  flags|=64; if (reused) flags|=128;
  /* Reopen every named parent and copy after publication; source descriptors never authorize a replaced path. */
  named=skill_open(owned->anchor,".pe",O_RDONLY | O_DIRECTORY);
  if (named<0) { error=errno; goto finished; }
  error=project_skill_directory(named,uid,gid,(dev_t)device,mount,&observed); if (error) goto finished;
  if (observed.st_dev!=meta.st_dev || observed.st_ino!=meta.st_ino) { error=ESTALE; goto finished; }
  if (retire_close(&named)) { close_failed=1; goto finished; }
  named=skill_open(metadata,"skills",O_RDONLY | O_DIRECTORY);
  if (named<0) { error=errno; goto finished; }
  error=project_skill_directory(named,uid,gid,(dev_t)device,mount,&observed); if (error) goto finished;
  if (observed.st_dev!=container.st_dev || observed.st_ino!=container.st_ino) { error=ESTALE; goto finished; }
  if (retire_close(&named)) { close_failed=1; goto finished; }
  named=skill_open(skills,id,O_RDONLY | O_DIRECTORY);
  if (named<0) { error=errno; goto finished; }
  error=project_skill_directory(named,uid,gid,(dev_t)device,mount,&observed); if (error) goto finished;
  if (observed.st_dev!=created.st_dev || observed.st_ino!=created.st_ino) { error=ESTALE; goto finished; }
  error=mount_identity(named,mount); if (error) goto finished;
  error=leaf_parent(owned,path,&close_failed); if (error || close_failed) goto finished;
  put32(frame+12,count+(reused ? 0 : 1));
  put64(frame+104,device); put64(frame+112,(uint64_t)created.st_ino); put64(frame+120,mount);
  put64(frame+128,body_length); put64(frame+136,resource_length);
  put32(frame+144,uid); put32(frame+148,gid); put32(frame+152,040700);
finished:
  if (retire_close(&named)) close_failed=1;
  if (retire_close(&version)) close_failed=1;
  if (retire_close(&skills)) close_failed=1;
  if (retire_close(&metadata)) close_failed=1;
  if (retire_close(&owned->anchor)) close_failed=1;
  owned->mount_id=0; free(path); free(id);
  if (close_failed) { if (!error) error=EIO; } else flags|=1;
  frame[5]=error ? (changed || close_failed || (flags & 32) ? 3 : 2) : 1;
  frame[6]=(unsigned char)flags; put32(frame+8,(uint32_t)error);
  return array;
}

/* Only these fixed private/project names enter the directory preparation receipt. */
static int skill_directory_open(int parent, const char *name, uint64_t retries, int32_t *cancel, uint64_t deadline) {
  for (uint64_t attempt=0;;attempt++) {
    int error=content_running(cancel,deadline); if (error) { errno=error; return -1; }
    int fd=skill_open(parent,name,O_RDONLY | O_DIRECTORY);
    if (fd>=0 || errno!=EAGAIN || attempt>=retries) return fd;
  }
}

static int skill_store_scan(int store, uid_t uid, gid_t gid, dev_t device, uint64_t mount,
  uint32_t max_records, uint32_t max_record, uint32_t max_bytes, uint32_t max_inodes, int *close_failed) {
  int copy=skill_open(store,".",O_RDONLY | O_DIRECTORY),error=0;
  if (copy<0) return errno;
  DIR *directory=fdopendir(copy);
  if (!directory) { error=errno; if (close(copy)) *close_failed=1; return error; }
  uint32_t count=0; uint64_t bytes=0;
  struct stat directory_stat; struct statfs filesystem;
  if (fstat(store,&directory_stat) || fstatfs(store,&filesystem)) error=errno;
  if (!error && (directory_stat.st_blocks<0 || filesystem.f_bsize<1 || filesystem.f_bsize>65536)) error=EFBIG;
  if (!error) bytes=(uint64_t)directory_stat.st_blocks*512;
  uint64_t block=error ? 1 : (uint64_t)filesystem.f_bsize;
  uint64_t temporary=((uint64_t)max_record+block-1)/block*block;
  /* Existing allocated blocks plus one record temporary and bounded ext4 directory growth are charged together. */
  for (; !error;) {
    errno=0; struct dirent *entry=readdir(directory);
    if (!entry) { error=errno; break; }
    const char *name=entry->d_name;
    if (!strcmp(name,".") || !strcmp(name,"..")) continue;
    if (count>=max_records || strlen(name)!=77 || strncmp(name,"project-",8) || strcmp(name+72,".json")) { error=EPERM; break; }
    for (unsigned at=8;at<72;at++) if (!((name[at]>='0' && name[at]<='9') || (name[at]>='a' && name[at]<='f'))) error=EPERM;
    if (error) break;
    int fd=skill_open(store,name,O_RDONLY); struct stat st;
    if (fd<0) { error=errno; break; }
    if (fstat(fd,&st)) error=errno;
    else if (!S_ISREG(st.st_mode) || st.st_nlink!=1 || st.st_uid!=uid || st.st_gid!=gid || (st.st_mode & 07777)!=0600
      || st.st_dev!=device || st.st_size<1 || (uint64_t)st.st_size>max_record) error=EPERM;
    else if (st.st_blocks<0) error=EFBIG;
    else { error=mount_identity(fd,mount); bytes+=(uint64_t)st.st_blocks*512; count++; }
    if (close(fd)) *close_failed=1;
    if (error || *close_failed) break;
  }
  if (!error && (bytes+temporary+4*block>max_bytes || (uint64_t)count+2>max_inodes)) error=EFBIG;
  if (closedir(directory)) *close_failed=1;
  return error;
}
static napi_value prepare_skill_directory(napi_env env, napi_callback_info info, const char *name, int policy, int store) {
  size_t count = store ? 14 : 10, length = 0, offset = 0;
  napi_value args[14], backing, array, cancel_backing;
  owned_fds *owned = state(env);
  if (!owned || owned->anchor >= 0 || owned->reader >= 0) return fail(env, EBUSY);
  void *memory = NULL, *cancel_data = NULL;
  if (napi_create_arraybuffer(env, 96, &memory, &backing) != napi_ok
    || napi_create_typedarray(env, napi_uint8_array, 96, backing, 0, &array) != napi_ok) return fail(env, ENOMEM);
  unsigned char *frame = memory;
  memset(frame, 0, 96); memcpy(frame, "DPM1", 4); frame[4] = 1;
  int error = EINVAL, unknown = 0, close_failed = 0, syncing = 0, named = -1;
  unsigned flags = 0;
  uint64_t device = 0, inode = 0, mount = 0, start = 0, deadline = 0;
  double uid_value = 0, gid_value = 0, retry_value = 0;
  uint32_t maximum = 0, timeout = 0, max_records = 0, max_record = 0, max_bytes = 0, max_inodes = 0;
  char *path = NULL;
  int32_t *cancel = NULL;
  napi_typedarray_type type;
  struct stat root, target, observed;
  struct statfs filesystem;
  _Static_assert(6 * sizeof(struct stat) + sizeof(struct statfs) + 2 * sizeof(struct statx)
    + sizeof(struct open_how) + 1024 <= 4096, "project metadata scratch exceeds reservation");
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != (size_t)(store ? 14 : 10)
    || !content_number(env, args[6], &maximum) || maximum > 16384 || !content_number(env, args[8], &timeout)
    || napi_get_value_double(env, args[4], &uid_value) != napi_ok || !(uid_value >= 1 && uid_value < UINT32_MAX)
    || uid_value != (uint32_t)uid_value
    || napi_get_value_double(env, args[5], &gid_value) != napi_ok || !(gid_value >= 1 && gid_value < UINT32_MAX)
    || gid_value != (uint32_t)gid_value
    || napi_get_value_double(env, args[7], &retry_value) != napi_ok || !(retry_value >= 0 && retry_value <= 9007199254740991.0)
    || retry_value != (double)(uint64_t)retry_value
    || !bounded_decimal(env, args[1], &device) || !bounded_decimal(env, args[2], &inode)
    || !bounded_decimal(env, args[3], &mount) || !mount
    || napi_get_typedarray_info(env, args[9], &type, &length, &cancel_data, &cancel_backing, &offset) != napi_ok
    || type != napi_int32_array || length != 1 || offset != 0 || !cancel_data) goto finished;
  if (store && (!content_number(env,args[10],&max_records) || !max_records
    || !content_number(env,args[11],&max_record) || !max_record
    || !content_number(env,args[12],&max_bytes) || !max_bytes
    || !content_number(env,args[13],&max_inodes) || !max_inodes)) goto finished;
  cancel = cancel_data;
  bool ordinary = false;
  if (napi_is_arraybuffer(env, cancel_backing, &ordinary) != napi_ok || ordinary) goto finished;
  path = bounded_text(env, args[0], maximum);
  if (!path || path[0] != '/' || strlen(path) + strlen(name) + 1 > maximum) goto finished;
  put64(frame + 24, device); put64(frame + 32, inode); put64(frame + 40, mount);
  if ((uint64_t)geteuid() != (uint64_t)uid_value || (uint64_t)getegid() != (uint64_t)gid_value) { error = EPERM; goto finished; }
  error = content_clock(&start); if (error) goto finished;
  deadline = start + (uint64_t)timeout * 1000000ULL;
  error = content_running(cancel, deadline); if (error) goto finished;
  owned->anchor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (owned->anchor < 0) { error = errno; goto finished; }
  if (fstat(owned->anchor, &root) || fstatfs(owned->anchor, &filesystem)) { error = errno; goto finished; }
  if (!S_ISDIR(root.st_mode) || (uint64_t)root.st_dev != device || (uint64_t)root.st_ino != inode) { error = ESTALE; goto finished; }
  if (root.st_uid != (uid_t)uid_value || root.st_gid != (gid_t)gid_value || (root.st_mode & 07777) != 0700
    || filesystem.f_type != EXT4_SUPER_MAGIC) { error = EPERM; goto finished; }
  error = mount_identity(owned->anchor, mount); if (error) goto finished;
  owned->mount_id = mount; flags |= PM_ROOT;
  if (store) {
    uint64_t block=(uint64_t)filesystem.f_bsize;
    if (!block || block>65536 || ((uint64_t)max_record+block-1)/block*block+5*block>max_bytes) { error=EFBIG; goto finished; }
  }
  error = leaf_parent(owned, path, &close_failed); if (error || close_failed) goto finished;
  error = content_running(cancel, deadline); if (error) goto finished;
  owned->reader = skill_directory_open(owned->anchor, name, (uint64_t)retry_value, cancel, deadline);
  if (owned->reader >= 0 && policy == 1) { error=EEXIST; goto finished; }
  if (owned->reader < 0 && errno == ENOENT) {
    if (policy == 0) { error=ENOENT; goto finished; }
    error = content_running(cancel, deadline); if (error) goto finished;
    error = leaf_parent(owned, path, &close_failed); if (error || close_failed) goto finished;
    flags |= PM_ATTEMPTED;
    if (!mkdirat(owned->anchor, name, 0700)) flags |= PM_CREATED;
    else {
      error = errno;
      if (error != EEXIST || policy == 1) { if (!definite_no_create(error)) unknown = 1; goto finished; }
    }
    owned->reader = skill_directory_open(owned->anchor, name, (uint64_t)retry_value, cancel, deadline);
  }
  if (owned->reader < 0) { error = errno; goto finished; }
  if (fstat(owned->reader, &target)) { error = errno; goto finished; }
  put32(frame + 12, (uint32_t)target.st_uid); put32(frame + 16, (uint32_t)target.st_gid);
  put32(frame + 20, (uint32_t)target.st_mode);
  put64(frame + 48, (uint64_t)target.st_dev); put64(frame + 56, (uint64_t)target.st_ino);
  if (!S_ISDIR(target.st_mode) || target.st_uid != (uid_t)uid_value || target.st_gid != (gid_t)gid_value
    || (target.st_mode & 07777) != 0700 || (uint64_t)target.st_dev != device) { error = EPERM; goto finished; }
  error = mount_identity(owned->reader, mount); if (error) goto finished;
  put64(frame + 64, mount); flags |= PM_DIRECTORY;
  if (store) { error=skill_store_scan(owned->reader,(uid_t)uid_value,(gid_t)gid_value,(dev_t)device,mount,max_records,max_record,max_bytes,max_inodes,&close_failed); if (error || close_failed) goto finished; }
  /* After obtaining the directory, finish durability and closure even if the observer has left. */
  syncing = 1;
  if (fsync(owned->reader)) { error = errno; goto finished; }
  flags |= PM_SYNCED;
  if (fsync(owned->anchor)) { error = errno; goto finished; }
  flags |= PM_PARENT_SYNCED;
  error = leaf_parent(owned, path, &close_failed); if (error || close_failed) goto finished;
  named = skill_directory_open(owned->anchor, name, (uint64_t)retry_value, cancel, deadline);
  if (named < 0) { error = errno; goto finished; }
  if (fstat(named, &observed)) { error = errno; goto finished; }
  if (observed.st_dev != target.st_dev || observed.st_ino != target.st_ino || !S_ISDIR(observed.st_mode)
    || observed.st_uid != target.st_uid || observed.st_gid != target.st_gid || (observed.st_mode & 07777) != 0700) {
    error = ESTALE; goto finished;
  }
  error = mount_identity(named, mount);
  if (!error) error = leaf_parent(owned, path, &close_failed);
finished:
  if (retire_close(&named)) close_failed = 1;
  if (retire_close(&owned->reader)) close_failed = 1;
  if (retire_close(&owned->anchor)) close_failed = 1;
  owned->mount_id = 0;
  free(path);
  if (close_failed) { if (!error) error = EIO; unknown = 1; }
  else flags |= PM_CLOSED;
  if (error && ((flags & PM_CREATED) || syncing)) unknown = 1;
  frame[5] = unknown ? 4 : error ? 3 : (flags & PM_CREATED) ? 2 : 1;
  frame[6] = (unsigned char)flags; put32(frame + 8, (uint32_t)error);
  return array;
}

static napi_value prepare_skill_store(napi_env env, napi_callback_info info) {
  return prepare_skill_directory(env,info,"skill-working-copies",1,1);
}
static napi_value prepare_skill_parent(napi_env env, napi_callback_info info) {
  return prepare_skill_directory(env,info,"skills",1,0);
}
static napi_value verify_skill_parent(napi_env env, napi_callback_info info) {
  return prepare_skill_directory(env,info,"skills",0,0);
}

static napi_value verify_skill_store(napi_env env, napi_callback_info info) {
  return prepare_skill_directory(env,info,"skill-working-copies",0,1);
}
