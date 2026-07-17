set dotenv-load := false

mod secrets 'secrets.just'

default:
    @just --list
