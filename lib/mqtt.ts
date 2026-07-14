import mqtt from "mqtt";
import config from "$config";

export default mqtt.connect("mqtt://mqtt.satsroute.com", config.mqtt);
