"""Fixed operation-owned pipes mux; wsproto owns WebSocket framing, Manager owns admission and stop."""
import struct

from wire import Refused, STREAM_VERSION, require

DATA_BYTES, WINDOW_BYTES, HEADER_BYTES = 4096, 8192, 12
DATA, EOF, CREDIT = 1, 2, 3
NAMES = {1: 'stdin', 2: 'stdout', 3: 'stderr', 4: 'control'}
HEADER = struct.Struct('!IBBHI')


def decode(message):
    require(type(message) is bytes and HEADER_BYTES <= len(message) <= HEADER_BYTES + DATA_BYTES, 'stream_frame_budget')
    length, kind, channel, reserved, sequence = HEADER.unpack(message[:HEADER_BYTES])
    payload = message[HEADER_BYTES:]
    require(length == len(message) - 4 and reserved == 0 and channel in NAMES and kind in [DATA, EOF, CREDIT], 'stream_frame')
    require((kind == DATA and len(payload) >= 1) or (kind == EOF and len(payload) == 0)
            or (kind == CREDIT and len(payload) == 4 and 1 <= int.from_bytes(payload, 'big') <= WINDOW_BYTES), 'stream_frame')
    return kind, channel, sequence, payload


def encode(kind, channel, sequence, payload):
    message = HEADER.pack(8 + len(payload), kind, channel, 0, sequence) + payload
    decode(message)
    return message


class PipeChannels:
    """Bounded bytes of the original Operation, never a second process or authority registry."""
    def __init__(self, spec):
        self.spec = spec['stream']
        self.inputs = ({1} if spec['stdin']['mode'] == 'pipe' else set()) | ({4} if self.spec['control'] == 'pipe' else set())
        self.outputs = {channel for channel in [2, 3, 4] if self.spec[NAMES[channel]] == 'pipe'}
        self.rows = {channel: {'sent': 0, 'received': 0, 'credit': WINDOW_BYTES, 'pending': 0} for channel in NAMES}
        self.incoming = {channel: bytearray() for channel in self.inputs}
        self.outgoing = {channel: bytearray() for channel in self.outputs}
        self.credit_owed = dict.fromkeys(self.inputs, 0)
        self.input_eof, self.output_eof, self.sent_eof, self.closed_inputs = set(), set(), set(), set()
        self.input_counts = dict.fromkeys(self.inputs, 0)
        self.output_counts = dict.fromkeys(self.outputs, 0)
        self.abandoned = dict.fromkeys(self.inputs, 0)
        self.stopped, self.next_channel = False, 0

    def frame(self, kind, channel, payload):
        row = self.rows[channel]
        require(row['sent'] < 0xffffffff, 'stream_sequence_exhausted')
        result = encode(kind, channel, row['sent'], payload)
        row['sent'] += 1
        return result

    def receive(self, message):
        kind, channel, sequence, payload = decode(message)
        row = self.rows[channel]
        require(sequence == row['received'] and sequence < 0xffffffff, 'stream_sequence')
        if kind == CREDIT:
            credit = int.from_bytes(payload, 'big')
            require(channel in self.outputs and credit <= WINDOW_BYTES - row['credit'], 'stream_credit')
            row['credit'] += credit
        else:
            require(channel in self.inputs and channel not in self.input_eof, 'stream_direction')
            if kind == EOF:
                self.input_eof.add(channel)
            else:
                limit = 4096 if channel == 1 else self.spec['limits']['controlInputBytes']
                require(not self.stopped and channel not in self.closed_inputs
                        and len(payload) <= WINDOW_BYTES - row['pending'], 'stream_input_window')
                require(self.input_counts[channel] + len(payload) <= limit, 'stream_input_budget')
                self.input_counts[channel] += len(payload)
                row['pending'] += len(payload)
                self.incoming[channel].extend(payload)
        row['received'] += 1

    def consumed(self, channel, count):
        require(type(count) is int and 1 <= count <= len(self.incoming[channel]), 'stream_consumption')
        del self.incoming[channel][:count]
        self.credit_owed[channel] += count

    def abort_inputs(self):
        self.stopped = True
        for channel, pending in self.incoming.items():
            self.abandoned[channel] += len(pending)
            pending.clear()  # Explicit original stop discards input without granting delivery credit.

    def read_allowance(self, name):
        channel = {'stdout': 2, 'stderr': 3, 'control': 4}[name]
        if channel not in self.outputs:
            return DATA_BYTES
        return min(DATA_BYTES, self.rows[channel]['credit'] - len(self.outgoing[channel]))

    def produced(self, name, data):
        channel = {'stdout': 2, 'stderr': 3, 'control': 4}[name]
        if channel not in self.outputs:
            return
        limit = self.spec['limits']['controlOutputBytes'] if channel == 4 else 65536
        require(self.output_counts[channel] + len(data) <= limit, 'stream_output_budget')
        require(len(data) <= self.read_allowance(name), 'stream_output_window')
        self.output_counts[channel] += len(data)
        self.outgoing[channel].extend(data)

    def ended(self, name):
        channel = {'stdout': 2, 'stderr': 3, 'control': 4}[name]
        if channel in self.outputs:
            self.output_eof.add(channel)

    def next_frame(self):
        # Fold tiny actual writes into one credit record instead of retaining one frame per byte.
        for channel in sorted(self.inputs):
            count = self.credit_owed[channel]
            if count:
                message = self.frame(CREDIT, channel, count.to_bytes(4, 'big'))
                self.rows[channel]['pending'] -= count
                self.credit_owed[channel] = 0
                return message
        channels = sorted(self.outputs)
        for _ in channels:
            channel = channels[self.next_channel % len(channels)]
            self.next_channel += 1
            pending = self.outgoing[channel]
            if pending:
                size = min(DATA_BYTES, len(pending), self.rows[channel]['credit'])
                require(size > 0, 'stream_credit')
                message = self.frame(DATA, channel, bytes(pending[:size]))
                del pending[:size]
                self.rows[channel]['credit'] -= size
                return message
            if channel in self.output_eof and channel not in self.sent_eof:
                message = self.frame(EOF, channel, b'')
                self.sent_eof.add(channel)
                return message
        return None

    def drained(self):
        return (self.sent_eof == self.outputs and all(not value for value in self.outgoing.values())
                and all(not value for value in self.incoming.values()) and not any(self.credit_owed.values())
                and all(self.rows[channel]['credit'] == WINDOW_BYTES for channel in self.outputs))


class WebSocketPeer:
    """A single already authenticated/registered operation holder; standard WS implementation is injected by Root."""
    def __init__(self, ws, events, operation):
        self.ws, self.events, self.operation = ws, events, operation
        self.channels = operation.stream
        self.fragments, self.protocol_output = bytearray(), bytearray()
        self.wire_pending = self.closing = self.failed = False
        self.opening = True

    def receive(self, chunk):
        require(not self.closing and not self.failed and 1 <= len(chunk) <= 4096, 'stream_closed')
        self.ws.receive_data(chunk)
        for event in self.ws.events():
            if isinstance(event, self.events.BytesMessage):
                require(len(self.fragments) + len(event.data) <= HEADER_BYTES + DATA_BYTES, 'stream_message_budget')
                self.fragments.extend(event.data)
                if event.message_finished:
                    message = bytes(self.fragments)
                    if decode(message)[0] == DATA:
                        require(self.operation.committed and not self.operation.released, 'stream_not_submitted')
                    self.channels.receive(message)
                    self.fragments.clear()
            elif isinstance(event, self.events.Ping):
                output = self.ws.send(event.response())
                require(len(self.protocol_output) + len(output) <= 4096, 'stream_protocol_budget')
                self.protocol_output.extend(output)
            elif isinstance(event, self.events.Pong):
                pass
            elif isinstance(event, self.events.CloseConnection):
                require(event.code == 1000 and not self.fragments and self.operation.released
                        and self.io_closed(), 'stream_early_close')
                self.closing = True
                self.protocol_output.extend(self.ws.send(event.response()))
            else:
                raise Refused(400, 'stream_binary_required')

    def next_wire(self):
        require(not self.wire_pending, 'stream_write_pending')
        if self.protocol_output:
            output = bytes(self.protocol_output)
            self.protocol_output.clear()
        elif not self.closing:
            message = self.channels.next_frame()
            output = b'' if message is None else self.ws.send(self.events.BytesMessage(data=message))
        else:
            output = b''
        self.wire_pending = bool(output)
        return output

    def sent_wire(self):
        require(self.wire_pending, 'stream_write_not_pending')
        self.wire_pending = False
        self.opening = False

    def io_closed(self):
        return not self.failed and not self.wire_pending and not self.protocol_output and self.channels.drained()


def accept_websocket(head, api, operation):
    """Manager must acquire the original row before exposing the returned AcceptConnection bytes."""
    connection, connection_type, events = api
    ws = connection(connection_type.SERVER)
    ws.receive_data(head)
    requests = list(ws.events())
    require(len(requests) == 1 and isinstance(requests[0], events.Request), 'stream_upgrade')
    request = requests[0]
    require(request.target == '/stream' and request.subprotocols == [STREAM_VERSION]
            and not request.extensions, 'stream_upgrade')
    output = ws.send(events.AcceptConnection(subprotocol=STREAM_VERSION))
    peer = WebSocketPeer(ws, events, operation)
    peer.wire_pending = True
    return peer, output
