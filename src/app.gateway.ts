import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    OnGatewayConnection,
    OnGatewayDisconnect,
    MessageBody,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import crypto from 'crypto';
import { ConfigService } from '@nestjs/config';

interface User {
    id: string;
    nickname: string;
}

@WebSocketGateway({
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    constructor(
        private readonly configService: ConfigService,
        private readonly TURN_SECRET = this.configService.getOrThrow('TURN_SECRET'),
    ) { }

    // Храним активных пользователей: socketId -> User
    private users: Map<string, User> = new Map();

    // Храним комнаты: roomId -> Set<socketId>
    private rooms: Map<string, Set<string>> = new Map();
    private readonly TURN_TTL = 86400; // Время жизни кредов (секунды)

    // 🔥 Генерация TURN кредов (HMAC)
    private generateTurnCredentials() {
        const timestamp = Math.floor(Date.now() / 1000) + this.TURN_TTL;
        const username = `${timestamp}:user_${Math.random().toString(36).substr(2, 9)}`;

        // Генерируем пароль через HMAC-SHA1
        const hmac = crypto.createHmac('sha1', this.TURN_SECRET);
        hmac.update(username);
        const password = hmac.digest('base64');

        return { username, password };
    }

    handleConnection(client: Socket) {
        console.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        const user = this.users.get(client.id);

        // Находим комнату пользователя и удаляем его оттуда
        for (const [roomId, members] of this.rooms.entries()) {
            if (members.has(client.id)) {
                members.delete(client.id);

                if (user) {
                    // Сообщаем остальным в комнате, что юзер ушел
                    client.to(roomId).emit('user-disconnected', {
                        userId: client.id,
                        nickname: user.nickname
                    });
                }

                // Если комната пустая, удаляем её из памяти
                if (members.size === 0) {
                    this.rooms.delete(roomId);
                    console.log(`Room ${roomId} deleted (empty)`);
                }
                break;
            }
        }

        if (user) {
            this.users.delete(client.id);
        }
        console.log(`Client disconnected: ${client.id}`);
    }

    @SubscribeMessage('create-room')
    handleCreateRoom(@ConnectedSocket() client: Socket) {
        const roomId = Math.random().toString(36).substring(2, 10); // Генерируем короткий ID
        this.rooms.set(roomId, new Set());
        return { roomId };
    }

    @SubscribeMessage('join')
    handleJoin(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { nickname: string; roomId: string },
    ) {
        const { nickname, roomId } = payload;

        // Создаем комнату, если она еще не существует (для подключения по ссылке)
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, new Set());
        }

        // Добавляем пользователя в комнату
        this.rooms.get(roomId)!.add(client.id);

        // Присоединяем сокет к комнате Socket.IO для удобной рассылки
        client.join(roomId);

        const user: User = { id: client.id, nickname };
        this.users.set(client.id, user);

        // Отправляем клиенту список уже подключенных пользователей В ЭТОЙ КОМНАТЕ
        const members = this.rooms.get(roomId)!;
        const existingUsers = Array.from(members)
            .filter((id) => id !== client.id)
            .map((id) => this.users.get(id))
            .filter((u): u is User => !!u);

        // 🔥 ГЕНЕРИРУЕМ УНИКАЛЬНЫЕ TURN КРЕДЫ
        const turnCreds = this.generateTurnCredentials();
        console.log(`Generated TURN creds for ${client.id}: ${turnCreds.username}`);

        // Отправляем список пользователей + TURN креды
        client.emit('users-list', {
            users: existingUsers,
            turnConfig: turnCreds // 🔥 Передаем конфиг на клиент
        });

        // Сообщаем всем остальным В ЭТОЙ КОМНАТЕ о новом пользователе
        client.to(roomId).emit('user-joined', user);
    }

    // Пересылка сигналов WebRTC (Offer, Answer, ICE)
    @SubscribeMessage('signal')
    handleSignal(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { targetId: string; type: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit },
    ) {
        // Отправляем сигнал конкретному пользователю
        // Примечание: targetId это socket.id получателя
        this.server.to(payload.targetId).emit('signal', {
            senderId: client.id,
            ...payload,
        });
    }
}