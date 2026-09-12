import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';

interface WebhookStatusError {
    code?: number | string;
    title?: string;
    message?: string;
}

interface WebhookStatus {
    id?: string;
    recipient_id?: string;
    status?: string;
    timestamp?: string;
    errors?: WebhookStatusError[];
}

interface WebhookMessageText {
    body?: string;
}

interface WebhookMessage {
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: WebhookMessageText;
}

interface WebhookChangeValue {
    metadata?: {
        display_phone_number?: string;
        phone_number_id?: string;
    };
    messages?: WebhookMessage[];
    statuses?: WebhookStatus[];
}

interface WebhookChange {
    field?: string;
    value?: WebhookChangeValue;
}

interface WebhookEntry {
    changes?: WebhookChange[];
}

interface WhatsAppWebhookPayload {
    entry?: WebhookEntry[];
}

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');

    if (
        mode === 'subscribe' &&
        token &&
        token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
        challenge
    ) {
        return new NextResponse(challenge, { status: 200 });
    }

    return NextResponse.json({ error: 'Webhook verification failed.' }, { status: 403 });
}

export async function POST(request: NextRequest) {
    try {
        const payload = (await request.json()) as WhatsAppWebhookPayload;
        const changes = payload.entry?.flatMap((entry) => entry.changes ?? []) ?? [];
        const events = changes
            .filter((change) => change.field === 'messages')
            .flatMap((change) => {
                const value = change?.value ?? {};
                const metadata = value.metadata ?? {};
                const statusEvents = (value.statuses ?? []).map((status) => {
                    const firstError = status?.errors?.[0] ?? null;

                    return {
                        waba_id: null,
                        phone_number_id: metadata.phone_number_id ?? null,
                        message_id: status.id,
                        recipient_phone: status.recipient_id ?? null,
                        direction: 'outbound',
                        status: status.status ?? 'unknown',
                        error_code: firstError?.code ? String(firstError.code) : null,
                        error_title: firstError?.title ?? null,
                        error_message: firstError?.message ?? null,
                        raw_payload: status,
                        last_event_at: status.timestamp
                            ? new Date(Number(status.timestamp) * 1000).toISOString()
                            : new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    };
                });

                const inboundEvents = (value.messages ?? []).map((message) => ({
                    waba_id: null,
                    phone_number_id: metadata.phone_number_id ?? null,
                    message_id: message.id,
                    recipient_phone: message.from ?? null,
                    direction: 'inbound',
                    message_text: message.type === 'text' ? message.text?.body ?? null : null,
                    status: 'received',
                    raw_payload: message,
                    last_event_at: message.timestamp
                        ? new Date(Number(message.timestamp) * 1000).toISOString()
                        : new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                }));

                return [...statusEvents, ...inboundEvents];
            })
            .filter((event) => event.message_id);

        if (events.length) {
            const supabaseAdmin = await createAdminClient();
            const { error } = await supabaseAdmin
                .from('whatsapp_message_events')
                .upsert(events, { onConflict: 'message_id' });

            if (error) {
                if (error.message?.toLowerCase().includes('message_text')) {
                    console.error(
                        '[Suscripta] WhatsApp webhook schema mismatch: add message_text to whatsapp_message_events.'
                    );
                }
                console.error('[Suscripta] Could not persist WhatsApp webhook statuses:', error);
            }
        }

        return NextResponse.json({ received: true });
    } catch (error) {
        console.error('[Suscripta] WhatsApp webhook error:', error);
        return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 });
    }
}
