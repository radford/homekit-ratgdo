// Copyright 2023 Brandon Matthews <thenewwazoo@optimaltour.us>
// All rights reserved. GPLv3 License

#include "SoftwareSerial.h"
#include "ratgdo.h"
#include "homekit_debug.h"
#include "LittleFS.h"
// #include "secplus.h"
#include "homekit.h"
#include "log.h"

#include "Reader.h"
#include "secplus2.h"
#include "Packet.h"
#include "cQueue.h"
#include "utilities.h"

/********************************** LOCAL STORAGE *****************************************/

struct PacketAction {
    Packet pkt;
    bool inc_counter;
};

Queue_t pkt_q;
SoftwareSerial sw_serial;
extern struct GarageDoor garage_door;

SecPlus2Reader reader;

uint32_t id_code = 0;
uint32_t rolling_code = 0;

extern long unsigned int led_on_time;

/*************************** FORWARD DECLARATIONS ******************************/

void sync();
bool transmit(PacketAction& pkt_ac);
void door_command(DoorAction action);
void send_get_status();

/********************************** MAIN LOOP CODE *****************************************/

void setup_comms() {
    RINFO("Setting up comms for secplus2.0 protocol");

    sw_serial.begin(9600, SWSERIAL_8N1, UART_RX_PIN, UART_TX_PIN, true);
    sw_serial.enableIntTx(false);
    sw_serial.enableAutoBaud(true); // found in ratgdo/espsoftwareserial branch autobaud

    LittleFS.begin();
    id_code = read_file_from_flash("id_code");
    if (!id_code) {
        RINFO("id code not found");
        id_code = (random(0x1, 0xFFF) << 12) | 0x539;
        write_file_to_flash("id_code", &id_code);
    }
    RINFO("id code %02X", id_code);

    rolling_code = read_file_from_flash("rolling");
    RINFO("rolling code %02X", rolling_code);

    q_init(&pkt_q, sizeof(PacketAction), 5, FIFO,  false);

    RINFO("Syncing rolling code counter after reboot...");
    sync();

}

void comms_loop() {
    if (sw_serial.available()) {
        // spin on receiving data until the whole packet has arrived

        uint8_t ser_data = sw_serial.read();
        if (reader.push_byte(ser_data)) {
            Packet pkt = Packet(reader.fetch_buf());
            pkt.print();

            switch (pkt.m_pkt_cmd) {
                case PacketCommand::Status:
                    {
                        switch (pkt.m_data.value.status.door) {
                            case DoorState::Open:
                                garage_door.current_state = CURR_OPEN;
                                garage_door.target_state = TGT_OPEN;
                                break;
                            case DoorState::Closed:
                                garage_door.current_state = CURR_CLOSED;
                                garage_door.target_state = TGT_CLOSED;
                                break;
                            case DoorState::Stopped:
                                garage_door.current_state = CURR_STOPPED;
                                garage_door.target_state = TGT_OPEN;
                                break;
                            case DoorState::Opening:
                                garage_door.current_state = CURR_OPENING;
                                garage_door.target_state = TGT_OPEN;
                                break;
                            case DoorState::Closing:
                                garage_door.current_state = CURR_CLOSING;
                                garage_door.target_state = TGT_CLOSED;
                                break;
                            case DoorState::Unknown:
                                RERROR("Got door state unknown");
                                break;
                        }

                        if (!garage_door.active) {
                            RINFO("activating door");
                            garage_door.active = true;
                            notify_homekit_active();
                            if (garage_door.current_state == CURR_OPENING || garage_door.current_state == CURR_OPEN) {
                                garage_door.target_state = TGT_OPEN;
                            } else {
                                garage_door.target_state = TGT_CLOSED;
                            }
                        }

                        RINFO("tgt %d curr %d", garage_door.target_state, garage_door.current_state);
                        notify_homekit_target_door_state_change();
                        notify_homekit_current_door_state_change();

                        if (pkt.m_data.value.status.light != garage_door.light) {
                            RINFO("Light Status %s", pkt.m_data.value.status.light ? "On" : "Off");
                            garage_door.light = pkt.m_data.value.status.light;
                            notify_homekit_light();
                        }

                        if (pkt.m_data.value.status.lock) {
                            garage_door.current_lock = CURR_LOCKED;
                            garage_door.target_lock = TGT_LOCKED;
                        } else {
                            garage_door.current_lock = CURR_UNLOCKED;
                            garage_door.target_lock = TGT_UNLOCKED;
                        }
                        notify_homekit_target_lock();
                        notify_homekit_current_lock();

                        break;
                    }

                case PacketCommand::Lock:
                    {
                        LockTargetState lock = garage_door.target_lock;
                        switch (pkt.m_data.value.lock.lock) {
                            case LockState::Off:
                                lock = TGT_UNLOCKED;
                                break;
                            case LockState::On:
                                lock = TGT_LOCKED;
                                break;
                            case LockState::Toggle:
                                if (lock == TGT_LOCKED) {
                                    lock = TGT_UNLOCKED;
                                } else {
                                    lock = TGT_LOCKED;
                                }
                                break;
                        }
                        if (lock != garage_door.target_lock) {
                            RINFO("Lock Cmd %d", lock);
                            garage_door.target_lock = lock;
                            notify_homekit_target_lock();
                        }
                        // Send a get status to make sure we are in sync
                        send_get_status();
                        break;
                    }

                case PacketCommand::Light:
                    {
                        bool l = garage_door.light;
                        switch (pkt.m_data.value.light.light) {
                            case LightState::Off:
                                l = false;
                                break;
                            case LightState::On:
                                l = true;
                                break;
                            case LightState::Toggle:
                            case LightState::Toggle2:
                                l = !garage_door.light;
                                break;
                        }
                        if (l != garage_door.light) {
                            RINFO("Light Cmd %s", l ? "On" : "Off");
                            garage_door.light = l;
                            notify_homekit_light();
                        }
                        // Send a get status to make sure we are in sync
                        // Should really only need to do this on a toggle,
                        // But safer to do it always
                        send_get_status();
                        break;
                    }

                case PacketCommand::Motion:
                    {
                        RINFO("Motion Detected");
                        // We got a motion message, so we know we have a motion sensor
                        // If it's not yet enabled, add the service
                        if (!garage_door.has_motion_sensor) {
                            RINFO("Detected new Motion Sensor.  Enabling Service");
                            enable_service_homekit_motion();
                            garage_door.has_motion_sensor = true;
                        }

                        /* When we get the motion detect message, notify HomeKit. Motion sensor
                           will continue to send motion messages every 5s until motion stops.
                           set a timer for 5 seconds to disable motion after the last message */
                        garage_door.motion_timer = millis() + 5000;
                        if (!garage_door.motion) {
                            garage_door.motion = true;
                            notify_homekit_motion();
                        }
                        // Update status because things like light may have changed states
                        send_get_status();
                        break;
                    }

                default:
                    RINFO("Support for %s packet unimplemented. Ignoring.", PacketCommand::to_string(pkt.m_pkt_cmd));
                    break;
            }
        }

    } else {
        PacketAction pkt_ac;

        if (q_peek(&pkt_q, &pkt_ac)) {
            if (transmit(pkt_ac)) {
                q_drop(&pkt_q);
            } else {
                RERROR("transmit failed, will retry");
            }
        }
    }
}

/********************************** CONTROLLER CODE *****************************************/

bool transmit(PacketAction& pkt_ac) {
    // Turn off LED
    digitalWrite(LED_BUILTIN, HIGH);
    led_on_time = millis() + 500;

    // inverted logic, so this pulls the bus low to assert it
    digitalWrite(UART_TX_PIN, HIGH);
    delayMicroseconds(1300);
    digitalWrite(UART_TX_PIN, LOW);
    delayMicroseconds(130);

    // check to see if anyone else is continuing to assert the bus after we have released it
    if (digitalRead(UART_RX_PIN)) {
        RINFO("Collision detected, waiting to send packet");
        return false;
    } else {
        uint8_t buf[SECPLUS2_CODE_LEN];
        if (pkt_ac.pkt.encode(rolling_code, buf) != 0) {
            RERROR("Could not encode packet");
            pkt_ac.pkt.print();
        } else {
            sw_serial.write(buf, SECPLUS2_CODE_LEN);
            delayMicroseconds(100);
        }

        if (pkt_ac.inc_counter) {
            rolling_code += 1;
            // TODO slow this rate down to save eeprom wear
            write_file_to_flash("rolling", &rolling_code);
        }
    }

    return true;
}

void sync() {
    // for exposition about this process, see docs/syncing.md

    PacketData d;
    d.type = PacketDataType::NoData;
    d.value.no_data = NoData();
    Packet pkt = Packet(PacketCommand::GetOpenings, d, id_code);
    PacketAction pkt_ac = {pkt, true};
    transmit(pkt_ac);

    delay(100);

    pkt = Packet(PacketCommand::GetStatus, d, id_code);
    pkt_ac.pkt = pkt;
    transmit(pkt_ac);

}

void door_command(DoorAction action) {

    PacketData data;
    data.type = PacketDataType::DoorAction;
    data.value.door_action.action = action;
    data.value.door_action.pressed = true;
    data.value.door_action.id = 1;

    Packet pkt = Packet(PacketCommand::DoorAction, data, id_code);
    PacketAction pkt_ac = {pkt, false};

    q_push(&pkt_q, &pkt_ac);

    pkt_ac.pkt.m_data.value.door_action.pressed = false;
    pkt_ac.inc_counter = true;

    q_push(&pkt_q, &pkt_ac);
}

void open_door() {
    RINFO("open door req\n");

    if (garage_door.current_state == CURR_OPENING) {
        RINFO("door already opening; ignored req");
        return;
    }

    door_command(DoorAction::Open);
}

void close_door() {
    RINFO("close door req\n");

    if (garage_door.current_state == CURR_CLOSING) {
        RINFO("door already closing; ignored req");
        return;
    }

    if (garage_door.current_state == CURR_OPENING) {
        door_command(DoorAction::Stop);
        // TODO? delay here and await the door having stopped, pending
        // implementation of a richer method of building conditions?
        // delay(1000);
    }

    door_command(DoorAction::Close);
}

void send_get_status() {
    PacketData d;
    d.type = PacketDataType::NoData;
    d.value.no_data = NoData();
    Packet pkt = Packet(PacketCommand::GetStatus, d, id_code);
    PacketAction pkt_ac = {pkt, true};
    q_push(&pkt_q, &pkt_ac);
}

void set_lock(uint8_t value) {
    PacketData data;
    data.type = PacketDataType::Lock;
    if (value) {
        data.value.lock.lock = LockState::On;
        garage_door.target_lock = TGT_LOCKED;
    } else {
        data.value.lock.lock = LockState::Off;
        garage_door.target_lock = TGT_UNLOCKED;
    }

    Packet pkt = Packet(PacketCommand::Lock, data, id_code);
    PacketAction pkt_ac = {pkt, true};

    q_push(&pkt_q, &pkt_ac);
    send_get_status();
}

void set_light(bool value) {
    PacketData data;
    data.type = PacketDataType::Light;
    if (value) {
        data.value.light.light = LightState::On;
    } else {
        data.value.light.light = LightState::Off;
    }

    Packet pkt = Packet(PacketCommand::Light, data, id_code);
    PacketAction pkt_ac = {pkt, true};

    q_push(&pkt_q, &pkt_ac);
    send_get_status();
}