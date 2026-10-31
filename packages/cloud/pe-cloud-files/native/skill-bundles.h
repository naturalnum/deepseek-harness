/* Full-tree operations share the original owned_fds instance and qualified ext4 domain. */
typedef struct { char *name; const unsigned char *data; size_t length; } bundle_member;
typedef struct {
  uid_t uid; gid_t gid; dev_t device; uint64_t mount, bytes, inodes, maximum_bytes, maximum_inodes;
  uint32_t max_file, max_depth; int writable; int *close_failed;
} bundle_scan;

static int bundle_name(const char *name, uint32_t max_depth) {
  if (!name || !*name || name[0]=='/') return 0;
  unsigned depth=1; const char *part=name;
  for (const unsigned char *p=(const unsigned char *)name;;p++) {
    if (*p=='\\' || *p==':' || (*p && (*p<32 || *p==127))) return 0;
    if (!*p || *p=='/') {
      size_t length=(const char *)p-part;
      if (!length || (length==1 && *part=='.') || (length==2 && !memcmp(part,"..",2))
        || p[-1]=='.' || p[-1]==' ') return 0;
      if (!*p) break;
      if (++depth>max_depth) return 0;
      part=(const char *)p+1;
    }
  }
  return depth<=max_depth;
}

static int bundle_parent(int root, const char *name, char **leaf, int *close_failed) {
  char *copy=strdup(name); if (!copy) { errno=ENOMEM; return -1; }
  char *slash=strrchr(copy,'/'); int fd;
  if (slash) { *slash=0; *leaf=strdup(slash+1); fd=skill_open(root,copy,O_RDONLY | O_DIRECTORY); }
  else { *leaf=strdup(copy); fd=skill_open(root,".",O_RDONLY | O_DIRECTORY); }
  free(copy);
  if (!*leaf) { if (fd>=0 && close(fd)) *close_failed=1; errno=ENOMEM; return -1; }
  return fd;
}

/* Every regular file, directory and failure residue is measured. Unsupported entries stop all admissions. */
static int bundle_walk(int fd, bundle_scan *scan, uint32_t depth, int remove) {
  if (depth>scan->max_depth) return EFBIG;
  struct stat st;
  if (fstat(fd,&st)) return errno;
  if (!S_ISDIR(st.st_mode) || st.st_uid!=scan->uid || st.st_gid!=scan->gid || st.st_dev!=scan->device
    || (scan->writable ? (st.st_mode & 07000)!=0 : ((st.st_mode & 07777)!=0500 && (st.st_mode & 07777)!=0700))) return EPERM;
  int error=mount_identity(fd,scan->mount); if (error) return error;
  if (++scan->inodes>scan->maximum_inodes) return EFBIG;
  if (remove && fchmod(fd,0700)) return errno;
  int copy=skill_open(fd,".",O_RDONLY | O_DIRECTORY);
  if (copy<0) return errno;
  DIR *directory=fdopendir(copy);
  if (!directory) { error=errno; if (close(copy)) *scan->close_failed=1; return error; }
  for (;;) {
    errno=0; struct dirent *entry=readdir(directory);
    if (!entry) { error=errno; break; }
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    int child=skill_open(fd,entry->d_name,O_RDONLY);
    if (child<0) { error=errno; break; }
    struct stat before,after;
    if (fstat(child,&before)) error=errno;
    else if (before.st_uid!=scan->uid || before.st_gid!=scan->gid || before.st_dev!=scan->device) error=EPERM;
    else error=mount_identity(child,scan->mount);
    if (!error && S_ISDIR(before.st_mode)) error=bundle_walk(child,scan,depth+1,remove);
    else if (!error) {
      if (!S_ISREG(before.st_mode) || before.st_nlink!=1 || before.st_size<0
        || (scan->writable ? (before.st_mode & 07000)!=0 : ((before.st_mode & 07777)!=0400 && (before.st_mode & 07777)!=0600))) error=EPERM;
      else if ((uint64_t)before.st_size>scan->max_file || ++scan->inodes>scan->maximum_inodes
        || (uint64_t)before.st_size>scan->maximum_bytes-scan->bytes) error=EFBIG;
      else scan->bytes+=(uint64_t)before.st_size;
    }
    if (!error && remove) {
      if (fstatat(fd,entry->d_name,&after,AT_SYMLINK_NOFOLLOW)) error=errno;
      else if (after.st_dev!=before.st_dev || after.st_ino!=before.st_ino || (after.st_mode & S_IFMT)!=(before.st_mode & S_IFMT)) error=ESTALE;
      else if (unlinkat(fd,entry->d_name,S_ISDIR(before.st_mode) ? AT_REMOVEDIR : 0)) error=errno;
    }
    if (close(child)) *scan->close_failed=1;
    if (error || *scan->close_failed) break;
  }
  if (!error && remove && fsync(fd)) error=errno;
  if (closedir(directory)) *scan->close_failed=1;
  return error;
}

static int bundle_inventory(int skills, bundle_scan *scan, uint32_t maximum, uint32_t max_catalog,
  uint32_t *versions, int allow_pointer) {
  int copy=skill_open(skills,".",O_RDONLY | O_DIRECTORY),error=0;
  if (copy<0) return errno;
  DIR *directory=fdopendir(copy);
  if (!directory) { error=errno; if (close(copy)) *scan->close_failed=1; return error; }
  /* Both atomic pointer slots and the skills directory are reserved before any publication. */
  scan->bytes=allow_pointer ? (uint64_t)max_catalog*2 : 0; scan->inodes=allow_pointer ? 3 : 1;
  if (scan->bytes>scan->maximum_bytes || scan->inodes>scan->maximum_inodes) error=EFBIG;
  while (!error) {
    errno=0; struct dirent *entry=readdir(directory);
    if (!entry) { error=errno; break; }
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    if (allow_pointer && !strcmp(entry->d_name,"current.json")) {
      int fd=skill_open(skills,entry->d_name,O_RDONLY); struct stat st;
      if (fd<0) { error=errno; break; }
      if (fstat(fd,&st)) error=errno;
      else if (!S_ISREG(st.st_mode) || st.st_nlink!=1 || st.st_uid!=scan->uid || st.st_gid!=scan->gid
        || st.st_dev!=scan->device || (st.st_mode & 07777)!=0600 || st.st_size<0 || (uint64_t)st.st_size>max_catalog) error=EPERM;
      else error=mount_identity(fd,scan->mount);
      if (close(fd)) *scan->close_failed=1;
      continue;
    }
    const char *id=entry->d_name;
    if (!strncmp(id,".pending-",9)) id+=9;
    if (!skill_uuid(id)) { error=EPERM; break; }
    if (++*versions>maximum) { error=EFBIG; break; }
    int fd=skill_open(skills,entry->d_name,O_RDONLY | O_DIRECTORY);
    if (fd<0) { error=errno; break; }
    error=bundle_walk(fd,scan,0,0);
    if (close(fd)) *scan->close_failed=1;
  }
  if (closedir(directory)) *scan->close_failed=1;
  return error;
}

static int bundle_compare(int root, bundle_member *members, uint32_t files, char **directories, uint32_t dirs,
  bundle_scan *scan, int writable) {
  struct stat root_info;
  if (fstat(root,&root_info)) return errno;
  if ((root_info.st_mode & 07777)!=(writable ? 0700 : 0500)) return ESTALE;
  bundle_scan actual=*scan; actual.bytes=0; actual.inodes=0;
  int error=bundle_walk(root,&actual,0,0);
  uint64_t bytes=0; for (uint32_t i=0;i<files;i++) bytes+=members[i].length;
  if (!error && (actual.bytes!=bytes || actual.inodes!=1+(uint64_t)files+dirs)) error=ESTALE;
  for (uint32_t i=0;!error && i<dirs;i++) {
    int fd=skill_open(root,directories[i],O_RDONLY | O_DIRECTORY); struct stat st;
    if (fd<0) { error=errno; break; }
    if (fstat(fd,&st)) error=errno;
    else if ((st.st_mode & 07777)!=(writable ? 0700 : 0500)) error=ESTALE;
    if (close(fd)) *scan->close_failed=1;
  }
  for (uint32_t i=0;!error && i<files;i++) {
    if (writable) error=project_skill_contents(root,members[i].name,members[i].data,members[i].length,
      scan->uid,scan->gid,scan->device,scan->mount,scan->close_failed);
    else {
      int fd=skill_open(root,members[i].name,O_RDONLY); struct stat st; unsigned char block[65536]; size_t offset=0;
      if (fd<0) { error=errno; break; }
      if (fstat(fd,&st)) error=errno;
      else if ((st.st_mode & 07777)!=0400 || st.st_size<0 || (uint64_t)st.st_size!=members[i].length) error=ESTALE;
      while (!error && offset<members[i].length) {
        size_t wanted=members[i].length-offset; if (wanted>sizeof(block)) wanted=sizeof(block);
        ssize_t got=read(fd,block,wanted);
        if (got<0 && errno==EINTR) continue;
        if (got<=0 || memcmp(block,members[i].data+offset,(size_t)got)) { error=got<0 ? errno : ESTALE; break; }
        offset+=(size_t)got;
      }
      if (close(fd)) *scan->close_failed=1;
    }
  }
  return error;
}

static int bundle_operation_number(napi_env env, napi_value value, uint32_t *result) {
  double number;
  if (napi_get_value_double(env,value,&number)!=napi_ok || !(number>=0 && number<=2)
    || number!=(uint32_t)number) return 0;
  *result=(uint32_t)number;
  return 1;
}

/* Numeric operation 0 prepares private immutable data, 1 copies a complete tree, 2 reclaims only unreferenced private data. */
static napi_value skill_bundle_operation(napi_env env, napi_callback_info info) {
  napi_value args[24],array,backing,value,buffer; size_t argc=24,offset=0,cancel_length=0;
  napi_typedarray_type type; void *memory=NULL,*cancel=NULL; owned_fds *owned=state(env);
  if (!owned || owned->anchor>=0 || owned->reader>=0) return fail(env,EBUSY);
  if (napi_create_arraybuffer(env,128,&memory,&backing)!=napi_ok
    || napi_create_typedarray(env,napi_uint8_array,128,backing,0,&array)!=napi_ok) return fail(env,ENOMEM);
  unsigned char *frame=memory; memset(frame,0,128); frame[4]=1;
  uint64_t device=0,inode=0,mount=0,metadata_inode=0,expected_copy=0,start=0;
  uint32_t uid=0,gid=0,op=0,max_versions=0,max_bytes=0,max_inodes=0,max_file=0,max_entries=0,max_depth=0,max_path=0,
    max_catalog=0,timeout=0,files=0,dirs=0,keeps=0,versions=0,removed=0;
  int error=EINVAL,changed=0,close_failed=0,unknown=0,skills=-1,metadata=-1,version=-1,named=-1,pointer=-1;
  unsigned flags=0; char *path=NULL,*id=NULL,*revision=NULL,temporary[48];
  bundle_member *members=NULL; char **directories=NULL,**retained=NULL;
  struct stat root,meta,container,created,observed; struct statfs filesystem;
  bundle_scan scan={0};
  if (napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=24
    || !bounded_decimal(env,args[1],&device) || !bounded_decimal(env,args[2],&inode) || !bounded_decimal(env,args[3],&mount) || !mount
    || !content_number(env,args[4],&uid) || !uid || !content_number(env,args[5],&gid) || !gid
    || !bundle_operation_number(env,args[6],&op)
    || !content_number(env,args[12],&max_versions) || !max_versions || max_versions>65536
    || !content_number(env,args[13],&max_bytes) || !max_bytes || !content_number(env,args[14],&max_inodes) || !max_inodes
    || !content_number(env,args[15],&max_file) || !max_file || !content_number(env,args[16],&max_entries) || !max_entries
    || !content_number(env,args[17],&max_depth) || !max_depth || max_depth>66
    || !content_number(env,args[18],&max_path) || !max_path || max_path>16384
    || !content_number(env,args[19],&max_catalog) || !max_catalog || !content_number(env,args[20],&timeout) || !timeout
    || !bounded_decimal(env,args[22],&metadata_inode) || !bounded_decimal(env,args[23],&expected_copy)
    || napi_get_typedarray_info(env,args[21],&type,&cancel_length,&cancel,&buffer,&offset)!=napi_ok
    || type!=napi_int32_array || cancel_length!=1 || offset || !cancel) goto finished;
  memcpy(frame,op==0 ? "DSB1" : op==1 ? "DBP1" : "DBR1",4);
  put64(frame+32,device); put64(frame+40,inode); put64(frame+48,mount);
  bool ordinary=false,is_array=false;
  if (napi_is_arraybuffer(env,buffer,&ordinary)!=napi_ok || ordinary) goto finished;
  path=bounded_text(env,args[0],max_path); id=bounded_text(env,args[7],36);
  size_t revision_length=0;
  if (napi_get_value_string_utf8(env,args[11],NULL,0,&revision_length)!=napi_ok || revision_length>191) goto finished;
  revision=calloc(revision_length+1,1); if (!revision) { error=ENOMEM; goto finished; }
  if (napi_get_value_string_utf8(env,args[11],revision,revision_length+1,&revision_length)!=napi_ok) goto finished;
  if (!path || path[0]!='/' || !skill_uuid(id) || strlen(path)+96>max_path || (op==1 && !metadata_inode)) goto finished;
  if (napi_is_array(env,args[8],&is_array)!=napi_ok || !is_array || napi_get_array_length(env,args[8],&files)!=napi_ok
    || files>max_entries || napi_is_array(env,args[9],&is_array)!=napi_ok || !is_array
    || napi_get_array_length(env,args[9],&dirs)!=napi_ok || dirs>max_entries-files
    || napi_is_array(env,args[10],&is_array)!=napi_ok || !is_array
    || napi_get_array_length(env,args[10],&keeps)!=napi_ok || keeps>max_versions || (op==2 ? files || dirs : !files)) goto finished;
  members=calloc(files ? files : 1,sizeof(*members)); directories=calloc(dirs ? dirs : 1,sizeof(*directories));
  retained=calloc(keeps ? keeps : 1,sizeof(*retained));
  if (!members || !directories || !retained) { error=ENOMEM; goto finished; }
  uint64_t plan_bytes=0;
  for (uint32_t i=0;i<files;i++) {
    napi_value item,name,data;
    if (napi_get_element(env,args[8],i,&item)!=napi_ok || napi_get_named_property(env,item,"relativePath",&name)!=napi_ok
      || napi_get_named_property(env,item,"data",&data)!=napi_ok) goto finished;
    members[i].name=bounded_text(env,name,max_path);
    if (!bundle_name(members[i].name,max_depth) || strlen(path)+96+strlen(members[i].name)>max_path
      || napi_get_typedarray_info(env,data,&type,&members[i].length,(void **)&members[i].data,&buffer,&offset)!=napi_ok
      || type!=napi_uint8_array || members[i].length>max_file || offset
      || napi_is_arraybuffer(env,buffer,&ordinary)!=napi_ok || !ordinary) goto finished;
    plan_bytes+=members[i].length; if (plan_bytes>max_bytes) { error=EFBIG; goto finished; }
    for (uint32_t j=0;j<i;j++) if (!strcmp(members[i].name,members[j].name)) goto finished;
  }
  for (uint32_t i=0;i<dirs;i++) {
    if (napi_get_element(env,args[9],i,&value)!=napi_ok) goto finished;
    directories[i]=bounded_text(env,value,max_path);
    if (!bundle_name(directories[i],max_depth) || strlen(path)+96+strlen(directories[i])>max_path) goto finished;
    for (uint32_t j=0;j<i;j++) if (!strcmp(directories[i],directories[j])) goto finished;
    for (uint32_t j=0;j<files;j++) if (!strcmp(directories[i],members[j].name)) goto finished;
  }
  for (uint32_t i=0;i<keeps;i++) {
    if (napi_get_element(env,args[10],i,&value)!=napi_ok) goto finished;
    retained[i]=bounded_text(env,value,36); if (!skill_uuid(retained[i])) goto finished;
    for (uint32_t j=0;j<i;j++) if (!strcmp(retained[i],retained[j])) goto finished;
  }
  if (geteuid()!=uid || getegid()!=gid) { error=EPERM; goto finished; }
  error=content_clock(&start); if (error) goto finished;
  error=content_running(cancel,start+(uint64_t)timeout*1000000ULL); if (error) goto finished;
  owned->anchor=open(path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (owned->anchor<0) { error=errno; goto finished; }
  if (fstat(owned->anchor,&root) || fstatfs(owned->anchor,&filesystem)) { error=errno; goto finished; }
  if (root.st_dev!=(dev_t)device || root.st_ino!=(ino_t)inode || filesystem.f_type!=EXT4_SUPER_MAGIC) { error=ESTALE; goto finished; }
  error=project_skill_directory(owned->anchor,uid,gid,(dev_t)device,mount,&root); if (error) goto finished;
  owned->mount_id=mount;
  error=leaf_parent(owned,path,&close_failed); if (error || close_failed) goto finished;
  if (op==1) {
    metadata=skill_open(owned->anchor,".pe",O_RDONLY | O_DIRECTORY);
    if (metadata<0) { error=errno; goto finished; }
    error=project_skill_directory(metadata,uid,gid,(dev_t)device,mount,&meta); if (error) goto finished;
    if (meta.st_ino!=(ino_t)metadata_inode) { error=ESTALE; goto finished; }
  }
  int parent=op==1 ? metadata : owned->anchor;
  skills=skill_open(parent,"skills",O_RDONLY | O_DIRECTORY);
  if (skills<0 && errno!=ENOENT) { error=errno; goto finished; }
  if (skills<0 && op!=0) { error=ENOENT; goto finished; }
  scan=(bundle_scan){ .uid=uid,.gid=gid,.device=(dev_t)device,.mount=mount,.maximum_bytes=max_bytes,
    .maximum_inodes=max_inodes,.max_file=op==1 ? max_bytes : max_file,.max_depth=max_depth,.writable=op==1,.close_failed=&close_failed };
  if (skills>=0) {
    error=project_skill_directory(skills,uid,gid,(dev_t)device,mount,&container); if (error) goto finished;
    error=bundle_inventory(skills,&scan,max_versions,max_catalog,&versions,op!=1); if (error || close_failed) goto finished;
  } else { scan.bytes=(uint64_t)max_catalog*2; scan.inodes=3; }
  if (op==2) {
    pointer=skill_open(skills,"current.json",O_RDONLY);
    if (pointer<0) { if (errno!=ENOENT || *revision) { error=ESTALE; goto finished; } }
    else {
      char actual[192];
      if (fstat(pointer,&observed)) { error=errno; goto finished; }
      if (!*revision || !text_version(&observed,actual,sizeof(actual)) || strcmp(actual,revision)) { error=ESTALE; goto finished; }
    }
    int copy=skill_open(skills,".",O_RDONLY | O_DIRECTORY); if (copy<0) { error=errno; goto finished; }
    DIR *directory=fdopendir(copy); if (!directory) { error=errno; if (close(copy)) close_failed=1; goto finished; }
    for (;;) {
      errno=0; struct dirent *entry=readdir(directory);
      if (!entry) { error=errno; break; }
      if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..") || !strcmp(entry->d_name,"current.json")) continue;
      int keep=0; for (uint32_t i=0;i<keeps;i++) if (!strcmp(entry->d_name,retained[i])) keep=1;
      if (keep) continue;
      if (!skill_uuid(entry->d_name)) { error=EPERM; break; }
      version=skill_open(skills,entry->d_name,O_RDONLY | O_DIRECTORY); if (version<0) { error=errno; break; }
      if (fstat(version,&created)) { error=errno; break; }
      if (fstatat(skills,entry->d_name,&observed,AT_SYMLINK_NOFOLLOW)) { error=errno; break; }
      if (created.st_dev!=observed.st_dev || created.st_ino!=observed.st_ino) { error=ESTALE; break; }
      changed=1; bundle_scan removal=scan; removal.bytes=0; removal.inodes=0;
      error=bundle_walk(version,&removal,0,1); if (error || close_failed) break;
      if (unlinkat(skills,entry->d_name,AT_REMOVEDIR)) { error=errno; break; }
      if (retire_close(&version)) { close_failed=1; break; }
      removed++;
    }
    if (closedir(directory)) close_failed=1;
    if (error || close_failed) goto finished;
  } else {
    version=skills<0 ? -1 : skill_open(skills,id,O_RDONLY | O_DIRECTORY);
    if (version>=0) {
      if (op!=1 || !expected_copy) { error=EEXIST; goto finished; }
      if (fstat(version,&created)) { error=errno; goto finished; }
      if (created.st_ino!=(ino_t)expected_copy) { error=ESTALE; goto finished; }
      if ((created.st_mode & 07777)!=0700) { error=ESTALE; goto finished; }
      /* Existing working data is user-editable. Scan every actual entry, retain content and file inode changes. */
      bundle_scan working=scan; working.bytes=0; working.inodes=0;
      error=bundle_walk(version,&working,0,0); if (error || close_failed) goto finished;
      flags|=8;
    } else {
      if (skills>=0 && errno!=ENOENT) { error=errno; goto finished; }
      if (expected_copy) { error=ESTALE; goto finished; }
      if (versions>=max_versions || scan.bytes+plan_bytes>max_bytes || scan.inodes+1+(uint64_t)files+dirs>max_inodes) { error=EFBIG; goto finished; }
      error=content_running(cancel,start+(uint64_t)timeout*1000000ULL); if (error) goto finished;
      if (skills<0) {
        if (mkdirat(parent,"skills",0700)) { error=errno; unknown=!definite_no_create(error); goto finished; } changed=1;
        skills=skill_open(parent,"skills",O_RDONLY | O_DIRECTORY); if (skills<0) { error=errno; goto finished; }
        if (fstat(skills,&container)) { error=errno; goto finished; }
      }
      snprintf(temporary,sizeof(temporary),".pending-%s",id);
      if (mkdirat(skills,temporary,0700)) { error=errno; unknown=!definite_no_create(error); goto finished; } changed=1;
      version=skill_open(skills,temporary,O_RDONLY | O_DIRECTORY); if (version<0) { error=errno; goto finished; }
      if (fstat(version,&created)) { error=errno; goto finished; }
      for (uint32_t i=0;i<dirs;i++) {
        char *leaf=NULL; int fd=bundle_parent(version,directories[i],&leaf,&close_failed);
        if (fd<0) { free(leaf); error=errno; goto finished; }
        if (mkdirat(fd,leaf,0700) || fsync(fd)) error=errno;
        free(leaf);
        if (close(fd)) close_failed=1;
        if (error || close_failed) goto finished;
      }
      for (uint32_t i=0;i<files;i++) {
        char *leaf=NULL; int fd=bundle_parent(version,members[i].name,&leaf,&close_failed);
        if (fd<0) { free(leaf); error=errno; goto finished; }
        error=op==1 ? project_skill_write(fd,leaf,members[i].data,members[i].length,&close_failed)
          : skill_write(fd,leaf,members[i].data,members[i].length,&close_failed);
        if (!error && fsync(fd)) error=errno;
        free(leaf);
        if (close(fd)) close_failed=1;
        if (error || close_failed) goto finished;
      }
      for (uint32_t i=dirs;i>0;i--) {
        int fd=skill_open(version,directories[i-1],O_RDONLY | O_DIRECTORY); if (fd<0) { error=errno; goto finished; }
        if ((op==0 && fchmod(fd,0500)) || fsync(fd)) error=errno;
        if (close(fd)) close_failed=1;
        if (error || close_failed) goto finished;
      }
      if ((op==0 && fchmod(version,0500)) || fsync(version)) { error=errno; goto finished; }
      if (syscall(SYS_renameat2,skills,temporary,skills,id,RENAME_NOREPLACE)) { error=errno; goto finished; }
      error=bundle_compare(version,members,files,directories,dirs,&scan,op==1); if (error || close_failed) goto finished;
    }
    put64(frame+56,device); put64(frame+64,(uint64_t)created.st_ino); put64(frame+72,mount);
    named=skill_open(skills,id,O_RDONLY | O_DIRECTORY); if (named<0) { error=errno; goto finished; }
    if (fstat(named,&observed)) { error=errno; goto finished; }
    if (observed.st_dev!=created.st_dev || observed.st_ino!=created.st_ino) { error=ESTALE; goto finished; }
  }
  if (fsync(skills) || fsync(parent) || fsync(owned->anchor)) { error=errno; goto finished; }
  error=leaf_parent(owned,path,&close_failed); if (error || close_failed) goto finished;
  if (op==1) {
    int check_meta=skill_open(owned->anchor,".pe",O_RDONLY | O_DIRECTORY);
    if (check_meta<0) { error=errno; goto finished; }
    error=project_skill_directory(check_meta,uid,gid,(dev_t)device,mount,&observed);
    if (!error && observed.st_ino!=(ino_t)metadata_inode) error=ESTALE;
    if (close(check_meta)) close_failed=1;
    if (error || close_failed) goto finished;
  }
  int check=skill_open(parent,"skills",O_RDONLY | O_DIRECTORY); if (check<0) { error=errno; goto finished; }
  if (fstat(check,&observed)) error=errno;
  else if (observed.st_dev!=container.st_dev || observed.st_ino!=container.st_ino) error=ESTALE;
  if (close(check)) close_failed=1;
  if (error || close_failed) goto finished;
  versions=0; error=bundle_inventory(skills,&scan,max_versions,max_catalog,&versions,op!=1);
  if (error || close_failed) goto finished;
  put32(frame+12,versions); put64(frame+16,scan.bytes); put64(frame+24,scan.inodes); put32(frame+80,removed); flags|=2;
finished:
  if (changed) flags|=4;
  if (retire_close(&pointer)) close_failed=1;
  if (retire_close(&named)) close_failed=1;
  if (retire_close(&version)) close_failed=1;
  if (retire_close(&skills)) close_failed=1;
  if (retire_close(&metadata)) close_failed=1;
  if (retire_close(&owned->anchor)) close_failed=1;
  owned->mount_id=0;
  if (members) for (uint32_t i=0;i<files;i++) free(members[i].name);
  if (directories) for (uint32_t i=0;i<dirs;i++) free(directories[i]);
  if (retained) for (uint32_t i=0;i<keeps;i++) free(retained[i]);
  free(members); free(directories); free(retained); free(path); free(id); free(revision);
  if (close_failed) { if (!error) error=EIO; } else flags|=1;
  frame[5]=error ? (unknown || changed || close_failed ? 3 : 2) : 1; frame[6]=(unsigned char)flags; put32(frame+8,(uint32_t)error);
  return array;
}
