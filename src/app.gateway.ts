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

interface User {
    id: string;
    nickname: string;
}

@WebSocketGateway({ cors: true })
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    // Храним активных пользователей: socketId -> User
    private users: Map<string, User> = new Map();

    handleConnection(client: Socket) {
        console.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        const user = this.users.get(client.id);
        if (user) {
            this.users.delete(client.id);
            // Сообщаем остальным, что юзер ушел
            client.broadcast.emit('user-disconnected', { userId: client.id, nickname: user.nickname });
        }
        console.log(`Client disconnected: ${client.id}`);
    }

    @SubscribeMessage('join')
    handleJoin(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { nickname: string },
    ) {
        const user: User = { id: client.id, nickname: payload.nickname };
        this.users.set(client.id, user);

        // Отправляем клиенту список уже подключенных пользователей
        const existingUsers = Array.from(this.users.entries())
            .filter(([id]) => id !== client.id)
            .map(([, u]) => u);

        client.emit('users-list', existingUsers);

        // Сообщаем всем остальным о новом пользователе
        client.broadcast.emit('user-joined', user);
    }

    // Пересылка сигналов WebRTC (Offer, Answer, ICE)
    @SubscribeMessage('signal')
    handleSignal(
        @ConnectedSocket() client: Socket,
        @MessageBody() payload: { targetId: string; type: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit },
    ) {
        // Отправляем сигнал конкретному пользователю
        this.server.to(payload.targetId).emit('signal', {
            senderId: client.id,
            ...payload,
        });
    }
}