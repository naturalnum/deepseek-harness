/* Fixed two-file private version preparation. Included only by the reviewed ABI8 helper. */
#ifndef DSH_FD_CONTENT_ABI
#error "Skill versions require the original ABI8 content helper"
#endif

enum { SV_CLOSED=1, SV_ROOT=2, SV_CONTAINER=4, SV_CREATED=8, SV_WRITTEN=16, SV_SEALED=32, SV_PUBLISHED=64, SV_SYNCED=128 };

static int skill_uuid(const char *value) {
  if (!value || strlen(value) != 36) return 0;
  for (unsigned i=0; i<36; i++) {
    if (i==8 || i==13 || i==18 || i==23) { if (value[i]!='-') return 0; }
    else if (!((value[i]>='0' && value[i]<='9') || (value[i]>='a' && value[i]<='f'))) return 0;
  }
  return 1;
}

static int skill_open(int parent, const char *name, int flags) {
  struct open_how how={0};
  how.flags=(uint64_t)(flags | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  how.resolve=RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
  return (int)syscall(SYS_openat2,parent,name,&how,sizeof(how));
}

static int skill_file(int parent, const char *name, uid_t uid, gid_t gid, dev_t device,
  uint64_t mount, uint64_t max_file, uint64_t *size, int *close_failed) {
  int fd=skill_open(parent,name,O_RDONLY), error=0;
  struct stat st;
  if (fd<0) return errno;
  if (fstat(fd,&st)) error=errno;
  else if (!S_ISREG(st.st_mode) || st.st_nlink!=1 || st.st_uid!=uid || st.st_gid!=gid
    || (st.st_mode & 07777)!=0400 || st.st_dev!=device || st.st_size<0 || (uint64_t)st.st_size>max_file) error=EPERM;
  else if (!(error=mount_identity(fd,mount))) *size=(uint64_t)st.st_size;
  if (close(fd)) *close_failed=1;
  return error;
}

/* Enumeration stops before retaining unbounded names or allocating any version data. */
static int skill_inventory(int skills, uid_t uid, gid_t gid, dev_t device, uint64_t mount,
  uint64_t maximum, uint64_t max_file, uint64_t *count, uint64_t *bytes, int *close_failed) {
  int copy=skill_open(skills,".",O_RDONLY | O_DIRECTORY), error=0;
  if (copy<0) return errno;
  DIR *dir=fdopendir(copy);
  if (!dir) { error=errno; if (close(copy)) *close_failed=1; return error; }
  for (;;) {
    errno=0;
    struct dirent *entry=readdir(dir);
    if (!entry) { error=errno; break; }
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    if (!strcmp(entry->d_name,"current.json")) {
      int pointer=skill_open(skills,"current.json",O_RDONLY);
      struct stat st;
      if (pointer<0) { error=errno; break; }
      if (fstat(pointer,&st)) error=errno;
      else if (!S_ISREG(st.st_mode) || st.st_nlink!=1 || st.st_uid!=uid || st.st_gid!=gid
        || (st.st_mode & 07777)!=0600 || st.st_dev!=device || st.st_size<0 || st.st_size>512) error=EPERM;
      else error=mount_identity(pointer,mount);
      if (close(pointer)) *close_failed=1;
      if (error) break;
      continue;
    }
    if (!skill_uuid(entry->d_name)) { error=EPERM; break; }
    if (*count>=maximum) { error=EFBIG; break; }
    int version=skill_open(skills,entry->d_name,O_RDONLY | O_DIRECTORY);
    struct stat st;
    if (version<0) { error=errno; break; }
    if (fstat(version,&st)) error=errno;
    else if (!S_ISDIR(st.st_mode) || (st.st_mode & 07777)!=0500 || st.st_uid!=uid || st.st_gid!=gid
      || st.st_dev!=device) error=EPERM;
    else error=mount_identity(version,mount);
    uint64_t first=0,second=0;
    if (!error) error=skill_file(version,"SKILL.md",uid,gid,device,mount,max_file,&first,close_failed);
    if (!error) error=skill_file(version,"resource.bin",uid,gid,device,mount,max_file,&second,close_failed);
    /* Extra entries (including links or abandoned writes) are never silently omitted from quota. */
    int child_copy=-1;
    DIR *children=NULL;
    if (!error) {
      child_copy=skill_open(version,".",O_RDONLY | O_DIRECTORY);
      if (child_copy<0) error=errno;
      else { children=fdopendir(child_copy); if (!children) { error=errno; if (close(child_copy)) *close_failed=1; } }
    }
    if (children) {
      unsigned seen=0;
      for (;;) {
        errno=0; struct dirent *child=readdir(children);
        if (!child) { if (errno) error=errno; break; }
        if (!strcmp(child->d_name,".") || !strcmp(child->d_name,"..")) continue;
        if (!strcmp(child->d_name,"SKILL.md")) seen|=1;
        else if (!strcmp(child->d_name,"resource.bin")) seen|=2;
        else { error=EPERM; break; }
      }
      if (!error && seen!=3) error=EPERM;
      if (closedir(children)) *close_failed=1;
    }
    if (close(version)) *close_failed=1;
    if (error) break;
    if (UINT64_MAX-*bytes<first || UINT64_MAX-(*bytes+first)<second) { error=EFBIG; break; }
    *bytes+=first+second; (*count)++;
  }
  if (closedir(dir)) *close_failed=1;
  return error;
}

static int skill_write(int directory, const char *name, const void *bytes, size_t length, int *close_failed) {
  int fd=openat(directory,name,O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600),error=0;
  if (fd<0) return errno;
  size_t offset=0;
  while (offset<length) {
    ssize_t written=write(fd,(const char *)bytes+offset,length-offset);
    if (written<0 && errno==EINTR) continue;
    if (written<=0) { error=written<0 ? errno : EIO; break; }
    offset+=(size_t)written;
  }
  if (!error && fchmod(fd,0400)) error=errno;
  if (!error && fsync(fd)) error=errno;
  if (close(fd)) *close_failed=1;
  return error;
}

/* The two pointer slots are reserved even before the first pointer CAS. */
static napi_value prepare_skill_version(napi_env env, napi_callback_info info) {
  napi_value args[16],backing,array,buffer;
  size_t argc=16,offset=0,body_length=0,resource_length=0,cancel_length=0;
  void *memory=NULL,*body=NULL,*resource=NULL,*cancel_data=NULL;
  napi_typedarray_type type;
  owned_fds *owned=state(env);
  if (!owned || owned->anchor>=0 || owned->reader>=0) return fail(env,EBUSY);
  if (napi_create_arraybuffer(env,128,&memory,&backing)!=napi_ok
    || napi_create_typedarray(env,napi_uint8_array,128,backing,0,&array)!=napi_ok) return fail(env,ENOMEM);
  unsigned char *frame=memory;
  memset(frame,0,128); memcpy(frame,"DSV1",4); frame[4]=1;
  uint64_t device=0,inode=0,mount=0,versions=0,total=0,start=0;
  uint32_t uid=0,gid=0,max_versions=0,max_bytes=0,max_inodes=0,max_file=0,timeout=0,max_path=0;
  int error=EINVAL,close_failed=0,changed=0,unknown=0,skills=-1,version=-1,named=-1;
  unsigned flags=0;
  char *path=NULL,*id=NULL;
  char temporary[48];
  struct stat root,container,created,observed;
  struct statfs filesystem;
  if (napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=16
    || !bounded_decimal(env,args[1],&device) || !bounded_decimal(env,args[2],&inode)
    || !bounded_decimal(env,args[3],&mount) || !mount
    || !content_number(env,args[4],&uid) || !uid || !content_number(env,args[5],&gid) || !gid
    || !content_number(env,args[9],&max_versions) || !max_versions || max_versions>65536
    || !content_number(env,args[10],&max_bytes) || max_bytes<1024
    || !content_number(env,args[11],&max_inodes) || max_inodes<6
    || !content_number(env,args[12],&max_file) || !max_file
    || !content_number(env,args[13],&timeout) || !timeout
    || !content_number(env,args[15],&max_path) || max_path>16384
    || napi_get_typedarray_info(env,args[7],&type,&body_length,&body,&buffer,&offset)!=napi_ok || type!=napi_uint8_array
    || napi_get_typedarray_info(env,args[8],&type,&resource_length,&resource,&buffer,&offset)!=napi_ok || type!=napi_uint8_array
    || napi_get_typedarray_info(env,args[14],&type,&cancel_length,&cancel_data,&buffer,&offset)!=napi_ok
    || type!=napi_int32_array || cancel_length!=1 || offset!=0 || !cancel_data) goto finished;
  bool ordinary=false;
  if (napi_is_arraybuffer(env,buffer,&ordinary)!=napi_ok || ordinary) goto finished;
  path=bounded_text(env,args[0],max_path); id=bounded_text(env,args[6],36);
  if (!path || path[0]!='/' || !skill_uuid(id) || strlen(path)+90>max_path) goto finished;
  put64(frame+32,device); put64(frame+40,inode); put64(frame+48,mount);
  if (body_length>max_file || resource_length>max_file || body_length+resource_length>(uint64_t)max_bytes-1024) { error=EFBIG; goto finished; }
  if (geteuid()!=uid || getegid()!=gid) { error=EPERM; goto finished; }
  error=content_clock(&start); if (error) goto finished;
  error=content_running(cancel_data,start+(uint64_t)timeout*1000000ULL); if (error) goto finished;
  owned->anchor=open(path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (owned->anchor<0) { error=errno; goto finished; }
  if (fstat(owned->anchor,&root) || fstatfs(owned->anchor,&filesystem)) { error=errno; goto finished; }
  if (root.st_dev!=(dev_t)device || root.st_ino!=(ino_t)inode) { error=ESTALE; goto finished; }
  if (!S_ISDIR(root.st_mode) || root.st_uid!=uid || root.st_gid!=gid || (root.st_mode & 07777)!=0700
    || filesystem.f_type!=EXT4_SUPER_MAGIC) { error=EPERM; goto finished; }
  error=mount_identity(owned->anchor,mount); if (error) goto finished;
  owned->mount_id=mount; flags|=SV_ROOT;
  error=leaf_parent(owned,path,&close_failed); if (error || close_failed) goto finished;
  skills=skill_open(owned->anchor,"skills",O_RDONLY | O_DIRECTORY);
  if (skills<0 && errno!=ENOENT) { error=errno; goto finished; }
  if (skills>=0) {
    if (fstat(skills,&container)) { error=errno; goto finished; }
    if (container.st_uid!=uid || container.st_gid!=gid || (container.st_mode & 07777)!=0700 || container.st_dev!=root.st_dev) { error=EPERM; goto finished; }
    error=mount_identity(skills,mount); if (error) goto finished;
    error=skill_inventory(skills,uid,gid,root.st_dev,mount,max_versions,max_file,&versions,&total,&close_failed);
    if (error || close_failed) goto finished;
    if (!fstatat(skills,id,&observed,AT_SYMLINK_NOFOLLOW)) { error=EEXIST; goto finished; }
    if (errno!=ENOENT) { error=errno; goto finished; }
  }
  put32(frame+12,(uint32_t)versions); put64(frame+16,total+1024); put64(frame+24,3+versions*3);
  if (versions>=max_versions || total+body_length+resource_length+1024>max_bytes || 3+(versions+1)*3>max_inodes) { error=EFBIG; goto finished; }
  /* Logical bounds above precede every directory/file mutation. Physical ext4 enforces other private writers. */
  error=content_running(cancel_data,start+(uint64_t)timeout*1000000ULL); if (error) goto finished;
  if (skills<0) {
    if (mkdirat(owned->anchor,"skills",0700)) { error=errno; unknown=!definite_no_create(error); goto finished; }
    changed=1; flags|=SV_CONTAINER;
    skills=skill_open(owned->anchor,"skills",O_RDONLY | O_DIRECTORY);
    if (skills<0) { error=errno; goto finished; }
    if (fsync(skills) || fsync(owned->anchor)) { error=errno; goto finished; }
  }
  if (fstat(skills,&container)) { error=errno; goto finished; }
  if (container.st_dev!=root.st_dev || container.st_uid!=uid || container.st_gid!=gid
    || (container.st_mode & 07777)!=0700) { error=EPERM; goto finished; }
  error=mount_identity(skills,mount); if (error) goto finished;
  snprintf(temporary,sizeof(temporary),".pending-%s",id);
  if (mkdirat(skills,temporary,0700)) { error=errno; unknown=!definite_no_create(error); goto finished; }
  changed=1; flags|=SV_CREATED;
  version=skill_open(skills,temporary,O_RDONLY | O_DIRECTORY);
  if (version<0) { error=errno; goto finished; }
  if (fstat(version,&created)) { error=errno; goto finished; }
  put64(frame+56,(uint64_t)created.st_dev); put64(frame+64,(uint64_t)created.st_ino); put64(frame+72,mount);
  /* After the first effect, finish both bounded files and durability despite observer cancellation. */
  error=skill_write(version,"SKILL.md",body,body_length,&close_failed); if (error || close_failed) goto finished;
  error=skill_write(version,"resource.bin",resource,resource_length,&close_failed); if (error || close_failed) goto finished;
  flags|=SV_WRITTEN;
  if (fchmod(version,0500) || fsync(version)) { error=errno; goto finished; }
  flags|=SV_SEALED;
  if (syscall(SYS_renameat2,skills,temporary,skills,id,RENAME_NOREPLACE)) { error=errno; goto finished; }
  flags|=SV_PUBLISHED;
  if (fsync(skills) || fsync(owned->anchor)) { error=errno; goto finished; }
  flags|=SV_SYNCED;
  named=skill_open(owned->anchor,"skills",O_RDONLY | O_DIRECTORY);
  if (named<0) { error=errno; goto finished; }
  if (fstat(named,&observed)) { error=errno; goto finished; }
  if (observed.st_dev!=container.st_dev || observed.st_ino!=container.st_ino || (observed.st_mode & 07777)!=0700
    || observed.st_uid!=uid || observed.st_gid!=gid) { error=ESTALE; goto finished; }
  error=mount_identity(named,mount); if (error) goto finished;
  if (retire_close(&named)) { close_failed=1; goto finished; }
  named=skill_open(skills,id,O_RDONLY | O_DIRECTORY);
  if (named<0) { error=errno; goto finished; }
  if (fstat(named,&observed)) { error=errno; goto finished; }
  if (observed.st_dev!=created.st_dev || observed.st_ino!=created.st_ino || (observed.st_mode & 07777)!=0500
    || observed.st_uid!=uid || observed.st_gid!=gid) { error=ESTALE; goto finished; }
  error=mount_identity(named,mount); if (error) goto finished;
  error=leaf_parent(owned,path,&close_failed); if (error || close_failed) goto finished;
  put32(frame+12,(uint32_t)(versions+1)); put64(frame+16,total+body_length+resource_length+1024);
  put64(frame+24,3+(versions+1)*3); put64(frame+80,body_length); put64(frame+88,resource_length);
finished:
  if (retire_close(&named)) close_failed=1;
  if (retire_close(&version)) close_failed=1;
  if (retire_close(&skills)) close_failed=1;
  if (retire_close(&owned->anchor)) close_failed=1;
  owned->mount_id=0;
  free(path); free(id);
  if (close_failed) { if (!error) error=EIO; }
  else flags|=SV_CLOSED;
  frame[5]=error ? (unknown || changed || close_failed ? 3 : 2) : 1;
  frame[6]=(unsigned char)flags; put32(frame+8,(uint32_t)error);
  return array;
}

/* Root's actual post-drain path only; this method is never present on an account skill port. */
static napi_value retire_skill_versions(napi_env env, napi_callback_info info) {
  napi_value args[12],array,backing,buffer;
  size_t argc=12,length=0,offset=0;
  void *memory=NULL,*cancel=NULL;
  napi_typedarray_type type;
  owned_fds *owned=state(env);
  if (!owned || owned->anchor>=0 || owned->reader>=0) return fail(env,EBUSY);
  if (napi_create_arraybuffer(env,96,&memory,&backing)!=napi_ok
    || napi_create_typedarray(env,napi_uint8_array,96,backing,0,&array)!=napi_ok) return fail(env,ENOMEM);
  unsigned char *frame=memory;
  memset(frame,0,96); memcpy(frame,"DSR1",4); frame[4]=1;
  uint64_t device=0,inode=0,mount=0,count=0,bytes=0;
  uint32_t uid=0,gid=0,max_versions=0,max_file=0,max_path=0,removed=0;
  unsigned flags=0;
  char *path=NULL,*current=NULL,*expected=NULL;
  int error=EINVAL,changed=0,close_failed=0,skills=-1,version=-1,pointer=-1,copy=-1,named=-1;
  DIR *directory=NULL;
  struct stat root,container,observed,selected;
  struct statfs filesystem;
  if (napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=12
    || !bounded_decimal(env,args[1],&device) || !bounded_decimal(env,args[2],&inode)
    || !bounded_decimal(env,args[3],&mount) || !mount
    || !content_number(env,args[4],&uid) || !uid || !content_number(env,args[5],&gid) || !gid
    || !content_number(env,args[8],&max_versions) || !max_versions || max_versions>65536
    || !content_number(env,args[9],&max_file) || !max_file || !content_number(env,args[11],&max_path) || max_path>16384
    || napi_get_typedarray_info(env,args[10],&type,&length,&cancel,&buffer,&offset)!=napi_ok
    || type!=napi_int32_array || length!=1 || offset!=0 || !cancel) goto finished;
  path=bounded_text(env,args[0],max_path); current=text(env,args[6]);
  size_t current_length=1;
  if (!current && napi_get_value_string_utf8(env,args[6],NULL,0,&current_length)==napi_ok && current_length==0) current=strdup("");
  expected=bounded_text(env,args[7],191);
  size_t expected_length=1;
  if (!expected && napi_get_value_string_utf8(env,args[7],NULL,0,&expected_length)==napi_ok && expected_length==0) expected=strdup("");
  if (!path || path[0]!='/' || !current || !expected || (*current && !skill_uuid(current)) || (!*current != !*expected)) goto finished;
  put64(frame+32,device); put64(frame+40,inode); put64(frame+48,mount);
  if (geteuid()!=uid || getegid()!=gid) { error=EPERM; goto finished; }
  if (text_cancelled(cancel)) { error=ECANCELED; goto finished; }
  owned->anchor=open(path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (owned->anchor<0) { error=errno; goto finished; }
  if (fstat(owned->anchor,&root) || fstatfs(owned->anchor,&filesystem)) { error=errno; goto finished; }
  if (root.st_dev!=(dev_t)device || root.st_ino!=(ino_t)inode || !S_ISDIR(root.st_mode)
    || root.st_uid!=uid || root.st_gid!=gid || (root.st_mode & 07777)!=0700 || filesystem.f_type!=EXT4_SUPER_MAGIC) { error=EPERM; goto finished; }
  error=mount_identity(owned->anchor,mount); if (error) goto finished;
  owned->mount_id=mount; flags|=2;
  error=leaf_parent(owned,path,&close_failed); if (error || close_failed) goto finished;
  skills=skill_open(owned->anchor,"skills",O_RDONLY | O_DIRECTORY);
  if (skills<0) { error=errno==ENOENT && !*current ? 0 : errno; goto finished; }
  if (fstat(skills,&container)) { error=errno; goto finished; }
  if (container.st_uid!=uid || container.st_gid!=gid || (container.st_mode & 07777)!=0700 || container.st_dev!=root.st_dev) { error=EPERM; goto finished; }
  error=mount_identity(skills,mount); if (error) goto finished;
  error=skill_inventory(skills,uid,gid,root.st_dev,mount,max_versions,max_file,&count,&bytes,&close_failed);
  if (error || close_failed) goto finished;
  pointer=skill_open(skills,"current.json",O_RDONLY);
  if (pointer<0) { if (errno!=ENOENT || *current) { error=errno; goto finished; } }
  else {
    if (!*current) { error=ESTALE; goto finished; }
    char actual_version[192];
    if (fstat(pointer,&observed)) { error=errno; goto finished; }
    if (!S_ISREG(observed.st_mode) || observed.st_nlink!=1 || !text_version(&observed,actual_version,sizeof(actual_version))
      || strcmp(actual_version,expected)) { error=ESTALE; goto finished; }
    if (retire_close(&pointer)) { close_failed=1; goto finished; }
    version=skill_open(skills,current,O_RDONLY | O_DIRECTORY);
    if (version<0) { error=errno; goto finished; }
    if (retire_close(&version)) { close_failed=1; goto finished; }
  }
  if (text_cancelled(cancel)) { error=ECANCELED; goto finished; }
  copy=skill_open(skills,".",O_RDONLY | O_DIRECTORY);
  if (copy<0) { error=errno; goto finished; }
  directory=fdopendir(copy);
  if (!directory) { error=errno; if (close(copy)) close_failed=1; copy=-1; goto finished; }
  copy=-1;
  for (;;) {
    errno=0; struct dirent *entry=readdir(directory);
    if (!entry) { error=errno; break; }
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..") || !strcmp(entry->d_name,"current.json") || !strcmp(entry->d_name,current)) continue;
    if (!skill_uuid(entry->d_name) || removed>=max_versions) { error=EPERM; break; }
    named=skill_open(owned->anchor,"skills",O_RDONLY | O_DIRECTORY);
    if (named<0) { error=errno; break; }
    if (fstat(named,&observed)) { error=errno; break; }
    if (observed.st_dev!=container.st_dev || observed.st_ino!=container.st_ino) { error=ESTALE; break; }
    if (retire_close(&named)) { close_failed=1; break; }
    version=skill_open(skills,entry->d_name,O_RDONLY | O_DIRECTORY);
    if (version<0) { error=errno; break; }
    if (fstat(version,&selected)) { error=errno; break; }
    if (selected.st_uid!=uid || selected.st_gid!=gid || (selected.st_mode & 07777)!=0500 || selected.st_dev!=root.st_dev) { error=EPERM; break; }
    error=mount_identity(version,mount); if (error) break;
    if (fstatat(skills,entry->d_name,&observed,AT_SYMLINK_NOFOLLOW)) { error=errno; break; }
    if (observed.st_dev!=selected.st_dev || observed.st_ino!=selected.st_ino) { error=ESTALE; break; }
    /* Completion is bounded by the already checked finite inventory; observer cancellation cannot split cleanup ownership. */
    changed=1;
    if (fchmod(version,0700) || unlinkat(version,"SKILL.md",0) || unlinkat(version,"resource.bin",0)
      || fsync(version) || unlinkat(skills,entry->d_name,AT_REMOVEDIR)) { error=errno; break; }
    if (retire_close(&version)) { close_failed=1; break; }
    removed++;
  }
  if (!error) {
    uint64_t remaining=0,remaining_bytes=0;
    error=skill_inventory(skills,uid,gid,root.st_dev,mount,max_versions,max_file,&remaining,&remaining_bytes,&close_failed);
    if (!error && remaining!=(*current ? 1U : 0U)) error=EIO;
    if (!error) { count=remaining; bytes=remaining_bytes; }
  }
  if (!error && (fsync(skills) || fsync(owned->anchor))) error=errno;
  if (!error) error=leaf_parent(owned,path,&close_failed);
finished:
  if (directory && closedir(directory)) close_failed=1;
  if (retire_close(&named)) close_failed=1;
  if (retire_close(&version)) close_failed=1;
  if (retire_close(&pointer)) close_failed=1;
  if (retire_close(&skills)) close_failed=1;
  if (retire_close(&owned->anchor)) close_failed=1;
  owned->mount_id=0;
  free(path); free(current); free(expected);
  if (close_failed) { if (!error) error=EIO; } else flags|=1;
  frame[5]=error ? (changed || close_failed ? 3 : 2) : 1;
  frame[6]=(unsigned char)flags; put32(frame+8,(uint32_t)error); put32(frame+12,removed);
  put64(frame+16,count); put64(frame+24,bytes);
  return array;
}
