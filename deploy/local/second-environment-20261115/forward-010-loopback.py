"""Only the two fixed 010 loopback TCP routes. No HTTP parsing, header rewriting or body logging."""
import asyncio,json,pathlib,signal,sys
R=pathlib.Path(__file__).resolve().parent;P=json.loads((R/'public/plan.json').read_text())
EXPECTED='e8ce05010ab49ad0a33d0a95d0eb02c4ae5ba5b56517476d130dba8ca2441a9c'
ROUTES={32803:18930,32804:18931};active={p:0 for p in ROUTES};tasks=set();servers=[]
async def command(*args):
    p=await asyncio.create_subprocess_exec(*args,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
    b,_=await p.communicate()
    if p.returncode:raise RuntimeError('Owned transport prerequisite failed')
    return b.decode().strip()
async def connection(reader,writer,external):
    if active[external]>=16:writer.close();await writer.wait_closed();return
    active[external]+=1;upstream=None;pair=[]
    try:
        remote,upstream=await asyncio.open_connection('10.247.121.2',ROUTES[external])
        async def pump(source,dest):
            while data:=await source.read(65536):
                dest.write(data);await dest.drain()
            if dest.can_write_eof():dest.write_eof()
        pair=[asyncio.create_task(pump(reader,upstream)),asyncio.create_task(pump(remote,writer))]
        await asyncio.gather(*pair)
    except (ConnectionError,OSError) as error:
        # A peer reset retires this transport only; it makes no application release claim.
        pass
    finally:
        for task in pair:task.cancel()
        await asyncio.gather(*pair,return_exceptions=True)
        for peer in [writer,upstream]:
            if peer is not None:
                peer.close()
                try:await peer.wait_closed()
                except (ConnectionError,OSError) as error:pass
        active[external]-=1
async def main():
    if sys.argv[1:]!=['--forward-two-owned-010-ports']:
        print(json.dumps({'inert':True,'argument':'--forward-two-owned-010-ports'}));return
    if await command('docker','inspect','--format','{{.Id}}',P['backendName'])!=EXPECTED:raise RuntimeError('Original backend identity changed')
    await command('docker','exec',P['backendName'],'sh','-c','command -v nc')
    stop=asyncio.Event();loop=asyncio.get_running_loop()
    for sig in [signal.SIGINT,signal.SIGTERM]:loop.add_signal_handler(sig,stop.set)
    def accept(reader,writer,port):
        task=asyncio.create_task(connection(reader,writer,port));tasks.add(task);task.add_done_callback(tasks.discard)
    try:
        for external in ROUTES:servers.append(await asyncio.start_server(lambda r,w,p=external:accept(r,w,p),'127.0.0.1',external,backlog=16))
        print(json.dumps({'listening':True,'owner':'Main','routes':ROUTES,'bind':'127.0.0.1','httpReplacement':False}),flush=True)
        await stop.wait()
    finally:
        for server in servers:server.close()
        for server in servers:await server.wait_closed()
        for task in list(tasks):task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        print(json.dumps({'listenersClosed':True,'transportPeersJoined':len(tasks)==0,'applicationOwnershipReleased':False}),flush=True)
if __name__=='__main__':asyncio.run(main())
