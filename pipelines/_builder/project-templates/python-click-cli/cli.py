#!/usr/bin/env python3
"""CLI entry point."""

import click
from rich.console import Console

console = Console()


@click.group()
def cli():
    """Project CLI."""
    pass


@cli.command()
@click.argument("name", default="world")
def hello(name: str):
    """Say hello."""
    console.print(f"Hello, [bold green]{name}[/bold green]!")


if __name__ == "__main__":
    cli()
