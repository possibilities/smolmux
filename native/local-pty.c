/* One Runtime-bound local Session. Private framed pipes, no socket or recovery.
 * fd 3 is a Runtime-only liveness pipe; traffic cannot postpone owner death.
 */
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <signal.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __APPLE__
#include <util.h>
#include <libproc.h>
#include <sys/proc.h>
#else
#include <pty.h>
#include <dirent.h>
#endif

#define LIMIT (32u * 1024u * 1024u)
#define FRAMES 4096
#define CHUNK 65536

typedef struct Frame { struct Frame *next; size_t size, offset; int64_t at; unsigned char data[]; } Frame;
typedef struct { Frame *first, *last; size_t bytes, count; } Queue;
typedef struct { pid_t pid; uint64_t start; int stopped, zombie; } Member;
typedef struct { Member *items; size_t count, capacity; } Members;
static pid_t leader;
static int master = -1, dead_owner, terminating, leader_exited, paused, action;
static int fatal_error, exit_sent, pty_eof, exec_failed;
static uint32_t action_id;
static int64_t action_at, termination_at, exit_at;
static Queue input, output;
static Members suspended;
static siginfo_t leader_status;

static int64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static uint32_t get32(const unsigned char *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
static void put32(unsigned char *p, uint32_t n) { p[0]=n>>24; p[1]=n>>16; p[2]=n>>8; p[3]=n; }
static int flag(int fd,int command,int value) { int result; do { result=fcntl(fd,command,value); } while(result<0&&errno==EINTR); return result; }
static int nonblocking(int fd) { int f=flag(fd,F_GETFL,0); return f<0?-1:flag(fd,F_SETFL,f|O_NONBLOCK); }
/* The private blocking boot pipe has one writer and carries only this errno.
 * Keep the post-fork failure path async-signal-safe, including interrupted writes. */
static void startup_failure(int fd,int error) {
  const unsigned char *data=(const unsigned char *)&error;
  size_t offset=0;
  while(offset<sizeof(error)) {
    ssize_t n=write(fd,data+offset,sizeof(error)-offset);
    if(n<0&&errno==EINTR) continue;
    if(n<=0) break;
    offset+=(size_t)n;
  }
  _exit(127);
}
static void child_signal(int sig) { (void)sig; }
static void clear(Queue *q) { while(q->first) { Frame *f=q->first; q->first=f->next; free(f); } memset(q,0,sizeof(*q)); }
static int push(Queue *q, const void *data, size_t size) {
  if(size > LIMIT-q->bytes || q->count >= FRAMES) return -1;
  Frame *f=malloc(sizeof(*f)+size); if(!f) return -1;
  f->next=NULL; f->size=size; f->offset=0; f->at=now_ms(); memcpy(f->data,data,size);
  if(q->last) q->last->next=f; else q->first=f;
  q->last=f; q->bytes+=size; q->count++; return 0;
}
static int emit(unsigned char op, uint32_t id, const void *payload, size_t size) {
  if(dead_owner) return 0;
  unsigned char *data=malloc(size+9); if(!data) return -1;
  data[0]=op; put32(data+1,id); put32(data+5,(uint32_t)size);
  if(size) memcpy(data+9,payload,size);
  int result=push(&output,data,size+9); free(data); return result;
}
static int flush(Queue *q,int fd) {
  while(q->first) {
    Frame *f=q->first; ssize_t n=write(fd,f->data+f->offset,f->size-f->offset);
    if(n<0) { if(errno==EINTR) continue; return errno==EAGAIN||errno==EWOULDBLOCK ? 0 : -1; }
    if(!n) return 0;
    f->offset+=(size_t)n; q->bytes-=(size_t)n;
    if(f->offset==f->size) { q->first=f->next; if(!q->first) q->last=NULL; q->count--; free(f); }
  }
  return 0;
}
static int append_member(Members *m,Member item) {
  if(m->count==m->capacity) { size_t c=m->capacity?m->capacity*2:32; Member *p=realloc(m->items,c*sizeof(*p)); if(!p) return -1; m->items=p; m->capacity=c; }
  m->items[m->count++]=item; return 0;
}
static int member_info(pid_t pid,Member *m) {
  if(getsid(pid)!=leader) return 0;
#ifdef __APPLE__
  struct proc_bsdinfo info;
  if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=(int)sizeof(info)) return getsid(pid)==leader?-1:0;
  m->start=(uint64_t)info.pbi_start_tvsec*1000000+info.pbi_start_tvusec;
  m->stopped=info.pbi_status==SSTOP; m->zombie=info.pbi_status==SZOMB;
#else
  char path[64],line[4096]; snprintf(path,sizeof(path),"/proc/%d/stat",pid);
  FILE *f=fopen(path,"r"); if(!f) return getsid(pid)==leader?-1:0;
  size_t length=fread(line,1,sizeof(line)-1,f); int invalid=ferror(f)||!feof(f); fclose(f);
  if(invalid||!length) return getsid(pid)==leader?-1:0;
  line[length]=0;
  char *p=strrchr(line,')'); if(!p) return getsid(pid)==leader?-1:0; p+=2;
  char state=*p; m->stopped=state=='T'||state=='t'; m->zombie=state=='Z';
  /* Field 3 is state; starttime is field 22. */
  for(int field=3;field<22;field++) { p=strchr(p,' '); if(!p) return getsid(pid)==leader?-1:0; p++; }
  m->start=strtoull(p,NULL,10);
  if(m->stopped) {
    /* A leader can show T before its thread group has finished stopping. */
    snprintf(path,sizeof(path),"/proc/%d/task",pid);
    DIR *tasks=opendir(path); if(!tasks) return getsid(pid)==leader?-1:0;
    struct dirent *task; int seen=0;
    for(;;) {
      errno=0; task=readdir(tasks); if(!task) { if(errno==EINTR) continue; if(errno) { closedir(tasks); return -1; } break; }
      char *end; long tid=strtol(task->d_name,&end,10); if(*end||tid<=0) continue;
      char task_path[96]; snprintf(task_path,sizeof(task_path),"/proc/%d/task/%ld/stat",pid,tid);
      FILE *tf=fopen(task_path,"r"); if(!tf) { if(errno==ENOENT) continue; closedir(tasks); return -1; }
      size_t count=fread(line,1,sizeof(line)-1,tf); int bad=ferror(tf)||!feof(tf); fclose(tf);
      if(bad||!count) { closedir(tasks); return -1; } line[count]=0;
      char *state=strrchr(line,')'); if(!state||strlen(state)<3) { closedir(tasks); return -1; }
      seen=1; if(state[2]!='T'&&state[2]!='t'&&state[2]!='Z') m->stopped=0;
    }
    closedir(tasks); if(!seen) return getsid(pid)==leader?-1:0;
  }
#endif
  m->pid=pid; return 1;
}
static int members(Members *m) {
  m->count=0;
#ifdef __APPLE__
  int count=proc_listallpids(NULL,0); if(count<=0) return -1;
  size_t cap=(size_t)count+256; pid_t *pids=malloc(cap*sizeof(pid_t)); if(!pids) return -1;
  int n=proc_listallpids(pids,(int)(cap*sizeof(pid_t)));
  if(n<=0 || (size_t)n>=cap) { free(pids); return -1; }
  for(int i=0;i<n;i++) { Member item; int found=member_info(pids[i],&item); if(found<0 || (found>0 && append_member(m,item)<0)) { free(pids); return -1; } }
  free(pids);
#else
  DIR *d=opendir("/proc"); if(!d) return -1; struct dirent *e;
  for(;;) { errno=0; e=readdir(d); if(!e) { if(errno==EINTR) continue; if(errno) { closedir(d); return -1; } break; } char *end; long pid=strtol(e->d_name,&end,10); if(*end||pid<=0) continue; Member item; int found=member_info((pid_t)pid,&item); if(found<0 || (found>0&&append_member(m,item)<0)) { closedir(d); return -1; } }
  closedir(d);
#endif
  return 0;
}
static int signal_member(Member m,int sig) {
  Member current;
  int found=member_info(m.pid,&current);
  if(found<0) return -1;
  if(!found||current.start!=m.start||current.zombie) return 0;
  return kill(m.pid,sig)==0||errno==ESRCH ? 0 : -1;
}
static int signal_all(int sig) {
  Members m={0}; if(members(&m)<0) { free(m.items); return -1; } int result=0;
  for(size_t i=0;i<m.count;i++) if(signal_member(m.items[i],sig)<0) result=-1;
  free(m.items); return result;
}
static void terminate(int immediate) {
  if(!terminating) {
    terminating=1; termination_at=now_ms(); action=0;
    if(!immediate) { signal_all(SIGTERM); signal_all(SIGCONT); }
  }
  if(immediate) { if(termination_at>now_ms()-1000) termination_at=now_ms()-1000; kill(leader,SIGKILL); signal_all(SIGKILL); }
}
static void failure(const char *message) {
  if(!fatal_error) { emit('E',action_id,message,strlen(message)); fatal_error=1; }
  terminate(1);
}
static int remember(Member m) {
  for(size_t i=0;i<suspended.count;i++) if(suspended.items[i].pid==m.pid && suspended.items[i].start==m.start) return 0;
  return append_member(&suspended,m);
}
static void progress_action(void) {
  if(!action||terminating) return;
  if(now_ms()-action_at>3000) { failure("process suspension did not settle within 3 seconds"); return; }
  if(input.first) return; /* Accepted input reaches the PTY before suspension. */
  int settled=1;
  if(action=='S') {
    Member first;
    int found=member_info(leader,&first);
    if(found<0) { failure("cannot inspect command leader"); return; }
    if(found>0&&!first.stopped&&!first.zombie) {
      if(remember(first)<0||signal_member(first,SIGSTOP)<0) { failure("cannot suspend command leader"); return; }
    }
    Members m={0}; if(members(&m)<0) { free(m.items); failure("cannot enumerate local Session processes"); return; }
    for(size_t i=0;i<m.count;i++) {
      Member item=m.items[i]; if(item.zombie||item.stopped) continue;
      settled=0;
      if(remember(item)<0||signal_member(item,SIGSTOP)<0) { free(m.items); failure("cannot suspend local Session"); return; }
    }
    if(m.count==0&&!leader_exited) settled=0;
    free(m.items);
  } else {
    for(size_t i=0;i<suspended.count;i++) {
      if(signal_member(suspended.items[i],SIGCONT)<0) { failure("cannot resume local Session"); return; }
    }
    /* Resume only once. A job may immediately stop itself again (SIGTTIN,
     * SIGTTOU, SIGSTOP); that is its own job control, not our suspension. */
  }
  if(settled) {
    paused=action=='S'; if(!paused) suspended.count=0;
    if(emit('A',action_id,NULL,0)<0) { failure("local output queue exceeded its bound"); return; }
    action=0;
  }
}
static void request(unsigned char op,uint32_t id,const unsigned char *data,size_t size) {
  if(terminating) return;
  if(op=='I'&&id==0) {
    if(paused||action=='S') { failure("input arrived while local Session was paused"); return; }
    if(size && push(&input,data,size)<0) failure("local input queue exceeded its bound");
  } else if(op=='R'&&id==0&&size==8) {
    uint32_t cols=get32(data),rows=get32(data+4);
    if(!cols||!rows||cols>4096||rows>4096||cols*rows>262144) { failure("invalid local PTY dimensions"); return; }
    struct winsize ws={.ws_row=(unsigned short)rows,.ws_col=(unsigned short)cols};
    if(ioctl(master,TIOCSWINSZ,&ws)<0&&errno!=EIO) failure("local PTY resize failed");
  } else if((op=='S'||op=='C')&&id&&size==0) {
    if(action) { emit('E',id,"another control request is pending",34); return; }
    if((op=='S')==paused) { emit('A',id,NULL,0); return; }
    action=op; action_id=id; action_at=now_ms();
  } else if(op=='K'&&id&&size==0) { action_id=id; terminate(0); }
  else failure("invalid local PTY request");
}
int main(int argc,char **argv) {
  if(argc<5) return 64;
  int cols=atoi(argv[1]),rows=atoi(argv[2]);
  if(cols<1||rows<1||cols>4096||rows>4096||(int64_t)cols*rows>262144) return 64;
  if(fcntl(3,F_GETFD)<0) return 64;
  signal(SIGPIPE,SIG_IGN);
  struct sigaction sa={0}; sa.sa_handler=child_signal; sigemptyset(&sa.sa_mask); sigaction(SIGCHLD,&sa,NULL);
  if(flag(3,F_SETFD,FD_CLOEXEC)<0) return 70;
  struct winsize ws={.ws_row=(unsigned short)rows,.ws_col=(unsigned short)cols};
  int boot[2];
  if(pipe(boot)<0) return 70;
  if(flag(boot[1],F_SETFD,FD_CLOEXEC)<0) return 70;
  leader=forkpty(&master,NULL,NULL,&ws);
  if(leader<0) return 70;
  if(leader==0) {
    close(3); close(boot[0]); signal(SIGPIPE,SIG_DFL); signal(SIGCHLD,SIG_DFL);
    if(chdir(argv[3])<0) startup_failure(boot[1],errno);
    execvp(argv[4],argv+4); startup_failure(boot[1],errno);
  }
  close(boot[1]);
  int boot_done=0,boot_error=0; size_t boot_bytes=0;
  if(nonblocking(0)<0||nonblocking(1)<0||nonblocking(3)<0||nonblocking(master)<0||nonblocking(boot[0])<0) {
    kill(leader,SIGKILL); signal_all(SIGKILL); while(waitpid(leader,NULL,0)<0&&errno==EINTR) {} return 70;
  }

  unsigned char header[9],payload[CHUNK]; size_t held=0,wanted=0,have=0; unsigned char op=0; uint32_t id=0;
  for(;;) {
    int64_t now=now_ms();
    if(!leader_exited) {
      memset(&leader_status,0,sizeof(leader_status));
      int waited; do { waited=waitid(P_PID,(id_t)leader,&leader_status,WEXITED|WNOWAIT|WNOHANG); } while(waited<0&&errno==EINTR);
      if(waited<0) failure("cannot observe local command exit");
      if(waited==0&&leader_status.si_pid==leader&&(leader_status.si_code==CLD_EXITED||leader_status.si_code==CLD_KILLED||leader_status.si_code==CLD_DUMPED)) {
        leader_exited=1; exit_at=now; terminate(1); clear(&input);
      }
    }
    if(terminating&&!exit_sent&&now-termination_at>=1000) signal_all(SIGKILL);
    progress_action();
    if(input.first&&now-input.first->at>30000) failure("local PTY input did not drain within 30 seconds");
    if(leader_exited&&boot_done&&!exit_sent) {
      Members m={0}; int result=members(&m),alive=0;
      if(result<0) alive=1;
      for(size_t i=0;i<m.count;i++) if(!m.items[i].zombie) alive=1;
      free(m.items);
      if(!alive&&(pty_eof||dead_owner)) {
        unsigned char bytes[12];
        put32(bytes,leader_status.si_code==CLD_EXITED?(uint32_t)leader_status.si_status:(uint32_t)-1);
        put32(bytes+4,leader_status.si_code==CLD_EXITED?0:(uint32_t)leader_status.si_status);
        put32(bytes+8,(uint32_t)exec_failed);
        if(emit('X',0,bytes,12)==0) exit_sent=1;
      }
    }
    if(exit_sent&&(!output.first||dead_owner)) break;
    if(terminating&&now-termination_at>6000) { clear(&output); return 70; }
    struct pollfd fds[5]={{3,POLLIN|POLLHUP,0},{0,terminating?0:POLLIN|POLLHUP,0},{1,output.first?POLLOUT:0,0},{master,(short)((pty_eof||exit_sent?0:POLLIN)|(input.first?POLLOUT:0)),0},{boot_done?-1:boot[0],POLLIN|POLLHUP,0}};
    int timeout=action||terminating?10:1000;
    int ready=poll(fds,5,timeout);
    if(ready<0) { if(errno==EINTR) continue; failure("local PTY poll failed"); continue; }
    /* Liveness always takes priority over potentially saturated streams. */
    if(fds[0].revents&(POLLIN|POLLHUP|POLLERR|POLLNVAL)) {
      char byte; ssize_t n=read(3,&byte,1);
      if(n==0||(n<0&&errno!=EAGAIN&&errno!=EINTR)||fds[0].revents&(POLLHUP|POLLERR|POLLNVAL)) {
        dead_owner=1; clear(&output); clear(&input); terminate(1);
      }
    }
    if(!boot_done&&fds[4].revents&(POLLIN|POLLHUP)) {
      ssize_t n=read(boot[0],((char*)&boot_error)+boot_bytes,sizeof(boot_error)-boot_bytes);
      if(n>0) boot_bytes+=(size_t)n;
      if(n==0||boot_bytes==sizeof(boot_error)) {
        boot_done=1; close(boot[0]);
        if(boot_bytes) { exec_failed=1; failure("local command setup or exec failed"); }
        else if(!dead_owner&&!fatal_error) { unsigned char pid[4]; put32(pid,(uint32_t)leader); emit('P',0,pid,4); }
      } else if(n<0&&errno!=EAGAIN&&errno!=EINTR) failure("local command startup handshake failed");
    }
    if(!dead_owner&&!terminating&&fds[1].revents&(POLLIN|POLLHUP)) {
      for(int turn=0;turn<64;turn++) {
        unsigned char *target=held<9?header+held:payload+have;
        size_t count=held<9?9-held:wanted-have;
        ssize_t n=read(0,target,count);
        if(n<0) { if(errno==EINTR) continue; if(errno!=EAGAIN) { dead_owner=1; terminate(1); } break; }
        if(!n) { dead_owner=1; clear(&output); terminate(1); break; }
        if(held<9) {
          held+=(size_t)n; if(held<9) continue;
          op=header[0]; id=get32(header+1); wanted=get32(header+5); have=0;
          if(wanted>CHUNK) { failure("oversized local PTY frame"); break; }
          if(wanted) continue;
        } else { have+=(size_t)n; if(have<wanted) continue; }
        request(op,id,payload,wanted); held=0; have=0;
        if(terminating) break;
      }
    }
    if(fds[3].revents&POLLOUT&&flush(&input,master)<0) { if(!leader_exited) failure("local PTY input failed"); else clear(&input); }
    if(!exit_sent&&fds[3].revents&(POLLIN|POLLHUP)) {
      unsigned char data[CHUNK]; ssize_t n=read(master,data,sizeof(data));
      if(n>0) { if(emit('O',0,data,(size_t)n)<0) failure("local output queue exceeded its bound"); }
      else if(!n||(n<0&&errno==EIO)) pty_eof=1;
      else if(errno!=EAGAIN&&errno!=EINTR) failure("local PTY output failed");
    }
    if(fds[2].revents&(POLLERR|POLLHUP)||(!dead_owner&&fds[2].revents&POLLOUT&&flush(&output,1)<0)) {
      dead_owner=1; clear(&output); terminate(1);
    }
  }
  int status; pid_t reaped; do { reaped=waitpid(leader,&status,0); } while(reaped<0&&errno==EINTR);
  if(reaped!=leader) fatal_error=1;
  close(master); clear(&input); clear(&output); free(suspended.items); return fatal_error?1:0;
}
